import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ApiTokenEntity } from '../entities/api-token.entity';
import { ProviderCredentialsEntity } from '../entities/credentials.entity';
import { KeyStorageService } from './key-storage.service';

export interface RotationReport {
  apiTokens: number;
  providerCredentials: number;
  keyFiles: number;
  failures: number;
  skipped: boolean;
}

/**
 * Re-seals every secret that still opens with a retired encryption key.
 *
 * Installations created before `SSH_KEY_ENCRYPTION_KEY` was generated at
 * bootstrap hold their provider API keys, access-key pairs and SSH private keys
 * under a key published in this repository. Generating a real key for new
 * installations does nothing for those records on its own — they stay readable
 * to anyone with a database dump until they are rewritten.
 *
 * So this runs on boot, right after the key is in place, and is idempotent: a
 * record already sealed with the active key is read and left alone. It never
 * fails startup. A half-finished pass is safe because each record is rewritten
 * on its own and `KeyStorageService` opens both generations.
 */
@Injectable()
export class SecretRotationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SecretRotationService.name);

  constructor(
    private readonly keyStorage: KeyStorageService,
    private readonly configService: ConfigService,
    @InjectRepository(ApiTokenEntity)
    private readonly apiTokens: Repository<ApiTokenEntity>,
    @InjectRepository(ProviderCredentialsEntity)
    private readonly providerCredentials: Repository<ProviderCredentialsEntity>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const report = await this.rotate();
      if (report.skipped) return;
      const total =
        report.apiTokens + report.providerCredentials + report.keyFiles;
      if (total === 0 && report.failures === 0) {
        this.logger.log(
          `Secrets are sealed with the current key (fingerprint ${this.keyStorage.keyFingerprint}).`,
        );
        return;
      }
      this.logger.warn(
        `Re-sealed ${total} secret(s) under the installation key ` +
          `(fingerprint ${this.keyStorage.keyFingerprint}): ` +
          `${report.apiTokens} provider credential(s), ` +
          `${report.providerCredentials} bearer credential(s), ` +
          `${report.keyFiles} private key file(s)` +
          (report.failures ? `, ${report.failures} could not be read` : ''),
      );
    } catch (error) {
      // Never block boot on this: an installation that cannot rotate is in the
      // state it was already in, and refusing to start would be strictly worse.
      this.logger.error(
        `Secret re-sealing did not complete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async rotate(): Promise<RotationReport> {
    if (this.keyStorage.sealingWithRetiredKey) {
      // There is nothing to rotate *to*. The constructor has already said so.
      return {
        apiTokens: 0,
        providerCredentials: 0,
        keyFiles: 0,
        failures: 0,
        skipped: true,
      };
    }

    const failures = { count: 0 };
    const [apiTokens, providerCredentials, keyFiles] = [
      await this.rotateApiTokens(failures),
      await this.rotateProviderCredentials(failures),
      await this.rotateKeyFiles(failures),
    ];

    return {
      apiTokens,
      providerCredentials,
      keyFiles,
      failures: failures.count,
      skipped: false,
    };
  }

  private reseal(
    ciphertext: string | null | undefined,
    failures: { count: number },
  ): string | null {
    if (!ciphertext) return null;
    try {
      const opened = this.keyStorage.openFromString(ciphertext);
      if (!opened.stale) return null;
      return this.keyStorage.encryptKeyToString(opened.plaintext);
    } catch {
      // Sealed with neither generation: leave it exactly as it is. Overwriting
      // would destroy the only copy, and the read path will report it in
      // context, where the operator can act on it.
      failures.count += 1;
      return null;
    }
  }

  private async rotateApiTokens(failures: { count: number }): Promise<number> {
    const rows = await this.apiTokens.find();
    let rotated = 0;

    for (const row of rows) {
      const token = this.reseal(row.encrypted_token, failures);
      const accessKey = this.reseal(row.encrypted_access_key, failures);
      if (!token && !accessKey) continue;

      await this.apiTokens.update(row.id, {
        ...(token ? { encrypted_token: token } : {}),
        ...(accessKey ? { encrypted_access_key: accessKey } : {}),
      });
      rotated += 1;
    }

    return rotated;
  }

  private async rotateProviderCredentials(failures: {
    count: number;
  }): Promise<number> {
    const rows = await this.providerCredentials.find();
    let rotated = 0;

    for (const row of rows) {
      const password = this.reseal(row.password, failures);
      const clientId = this.reseal(row.client_id, failures);
      const clientSecret = this.reseal(row.client_secret, failures);
      if (!password && !clientId && !clientSecret) continue;

      await this.providerCredentials.update(row.id, {
        ...(password ? { password } : {}),
        ...(clientId ? { client_id: clientId } : {}),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });
      rotated += 1;
    }

    return rotated;
  }

  /**
   * SSH private keys live as files, not columns. Each is rewritten through a
   * temporary file and renamed, so a crash mid-write cannot leave a key
   * truncated — the old bytes stay readable until the new ones are complete.
   */
  private async rotateKeyFiles(failures: { count: number }): Promise<number> {
    const base = this.configService.get<string>(
      'SSH_KEYS_PATH',
      '/secure/keys',
    );
    let rotated = 0;

    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // absent in local dev, and on any install with no stored keys
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        try {
          const sealed = await fs.readFile(full);
          const opened = this.keyStorage.open(sealed);
          if (!opened.stale) continue;

          const temporary = `${full}.rotating`;
          await fs.writeFile(
            temporary,
            this.keyStorage.encryptKey(opened.plaintext),
            {
              mode: 0o600,
            },
          );
          await fs.rename(temporary, full);
          rotated += 1;
        } catch {
          failures.count += 1;
        }
      }
    };

    await walk(base);
    return rotated;
  }
}
