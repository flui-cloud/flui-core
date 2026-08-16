import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * The key every installation used before `SSH_KEY_ENCRYPTION_KEY` was generated
 * at bootstrap. It is published in this repository, so anything still encrypted
 * with it is plaintext to anyone holding a database dump.
 *
 * It stays here as a *decryption* key only: an installation upgrading from an
 * older release has live data sealed with it, and refusing to open that data
 * would lock operators out of their own providers. SecretRotationService walks
 * those records and rewrites them under the real key; this constant can be
 * deleted once no supported upgrade path starts from a release that used it.
 */
export const RETIRED_DEFAULT_KEY_HEX =
  '0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

const KEY_HEX_LENGTH = 64;

export interface OpenedSecret {
  plaintext: string;
  /** The ciphertext only opened with a retired key, so it needs rewriting. */
  stale: boolean;
}

@Injectable()
export class KeyStorageService {
  private readonly keyBasePath: string;
  private readonly primaryKey: Buffer;
  /** Primary first, then retired keys, tried in order. */
  private readonly openingKeys: readonly Buffer[];
  private readonly logger = new Logger(KeyStorageService.name);

  /** True when this installation still seals new secrets with the public key. */
  readonly sealingWithRetiredKey: boolean;

  constructor(private readonly configService: ConfigService) {
    this.keyBasePath = this.configService.get<string>(
      'SSH_KEYS_PATH',
      '/secure/keys',
    );

    const configured = this.configService
      .get<string>('SSH_KEY_ENCRYPTION_KEY', '')
      .trim();

    if (!configured) {
      this.primaryKey = Buffer.from(RETIRED_DEFAULT_KEY_HEX, 'hex');
      this.sealingWithRetiredKey = true;
      this.logger.error(
        'SSH_KEY_ENCRYPTION_KEY is not set: provider credentials and SSH private keys ' +
          'are being sealed with a key published in the source tree. Set a 64-hex-character ' +
          'key (openssl rand -hex 32) and restart — existing records are re-sealed automatically.',
      );
    } else {
      this.primaryKey = KeyStorageService.parseKey(configured);
      this.sealingWithRetiredKey = configured === RETIRED_DEFAULT_KEY_HEX;
      if (this.sealingWithRetiredKey) {
        this.logger.error(
          'SSH_KEY_ENCRYPTION_KEY is set to the retired default, which is published in ' +
            'the source tree. Generate a fresh one with: openssl rand -hex 32',
        );
      }
    }

    const retired = Buffer.from(RETIRED_DEFAULT_KEY_HEX, 'hex');
    this.openingKeys = this.primaryKey.equals(retired)
      ? [this.primaryKey]
      : [this.primaryKey, retired];
  }

  /**
   * A malformed key must stop the process, not degrade quietly. `Buffer.from`
   * truncates on the first non-hex character, so a typo would otherwise produce
   * a short key that fails later inside `createCipheriv` — at the moment a
   * customer tries to reach their provider, with an error that says nothing.
   */
  private static parseKey(hex: string): Buffer {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== KEY_HEX_LENGTH) {
      throw new Error(
        `SSH_KEY_ENCRYPTION_KEY must be ${KEY_HEX_LENGTH} hexadecimal characters ` +
          `(32 bytes); got ${hex.length}. Generate one with: openssl rand -hex 32`,
      );
    }
    return Buffer.from(hex, 'hex');
  }

  /** Stable, non-reversible label for the active key, safe to log or expose. */
  get keyFingerprint(): string {
    return crypto
      .createHash('sha256')
      .update(this.primaryKey)
      .digest('hex')
      .slice(0, 16);
  }

  async storePrivateKey(
    userId: string,
    keyId: string,
    privateKey: string,
  ): Promise<string> {
    const keyPath = this.getKeyPath(userId, keyId);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });

    const encryptedKey = this.encryptKey(privateKey);
    await fs.writeFile(keyPath, encryptedKey);
    await fs.chmod(keyPath, 0o600);

    return keyPath;
  }

  async retrievePrivateKey(keyPath: string): Promise<string> {
    const encryptedKey = await fs.readFile(keyPath);
    return this.decryptKey(encryptedKey);
  }

  async deleteKey(keyPath: string): Promise<void> {
    try {
      await fs.unlink(keyPath);
      await this.cleanupKeyDirectory(keyPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  public encryptKeyToString(privateKey: string): string {
    const encryptedBuffer = this.encryptKey(privateKey);
    return encryptedBuffer.toString('base64');
  }

  public encryptKey(privateKey: string): Buffer {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.primaryKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(privateKey, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, encrypted]);
  }

  public decryptKey(encryptedData: Buffer): string {
    return this.open(encryptedData).plaintext;
  }

  public decryptKeyFromString(encryptedString: string): string {
    return this.openFromString(encryptedString).plaintext;
  }

  /**
   * Decrypts and reports which generation of key opened the record.
   *
   * GCM authenticates before it returns anything, so trying keys in turn is
   * unambiguous: a wrong key fails the tag check rather than yielding garbage.
   */
  public open(encryptedData: Buffer): OpenedSecret {
    const iv = encryptedData.subarray(0, 16);
    const authTag = encryptedData.subarray(16, 32);
    const payload = encryptedData.subarray(32);

    for (const [index, key] of this.openingKeys.entries()) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
          decipher.update(payload),
          decipher.final(),
        ]).toString('utf8');
        return { plaintext, stale: index > 0 };
      } catch {
        continue;
      }
    }

    throw new Error(
      "Could not decrypt: the record was not sealed with this installation's key. " +
        'If SSH_KEY_ENCRYPTION_KEY was changed by hand, restore the previous value — ' +
        'the data cannot be recovered without it.',
    );
  }

  public openFromString(encryptedString: string): OpenedSecret {
    return this.open(Buffer.from(encryptedString, 'base64'));
  }

  private getKeyPath(userId: string, keyId: string): string {
    return path.join(this.keyBasePath, userId, keyId, 'private.key');
  }

  private async cleanupKeyDirectory(keyPath: string): Promise<void> {
    const directory = path.dirname(keyPath);
    const files = await fs.readdir(directory);

    if (files.length === 0) {
      await fs.rmdir(directory);
      await this.cleanupKeyDirectory(directory);
    }
  }
}
