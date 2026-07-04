import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { gzipSync } from 'node:zlib';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';

// The insecure hardcoded default in KeyStorageService — if this is the live key,
// the SSH/CA material under /secure/keys is only nominally encrypted.
const INSECURE_SSH_KEY_DEFAULT =
  '0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

interface SecureKeyFile {
  relPath: string;
  mode: string;
  contentBase64: string;
}

export interface KeyBundleManifest {
  version: 1;
  createdAt: string;
  masterEnvId: string;
  /** Per-run DEK that encrypts the DB dump object; lives ONLY inside this sealed bundle. */
  dek: string;
  encryptionKey: string;
  encryptionKeyFingerprint: string;
  sshKeyEncryptionKey: string | null;
  sshKeyEncryptionKeyIsDefault: boolean;
  sshCa: {
    privateKey: string | null;
    publicKey: string | null;
    source: string;
  };
  zitadelPat: string | null;
  zitadelPatSource: string;
  secureKeys: SecureKeyFile[];
  databases: string[];
  zitadelCovered: boolean;
  insecureDefaults: string[];
}

export interface AssembledBundle {
  /** The age-encrypted (operator-recipient) bundle bytes, ready to upload. */
  ageBytes: Buffer;
  insecureDefaults: string[];
  encryptionKeyFingerprint: string;
}

/**
 * Assembles the master's key material into a single bundle sealed to an
 * operator-held age recipient (MVP-4). The master can encrypt to the recipient
 * but never decrypt — the private identity lives only on the operator's laptop.
 * All plaintext is built and encrypted in memory; only the age ciphertext is
 * ever returned. Key bytes are never logged (fingerprints only).
 */
@Injectable()
export class PlatformKeyBundleService {
  private readonly logger = new Logger(PlatformKeyBundleService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async assemble(input: {
    recipient: string;
    dek: Buffer;
    masterEnvId: string;
    databases: string[];
    zitadelCovered: boolean;
  }): Promise<AssembledBundle> {
    const insecureDefaults: string[] = [];

    const { keyHex: encryptionKey, fingerprint } =
      this.encryptionService.exportKeyMaterialForBundle();

    const sshKeyEncryptionKey =
      this.configService.get<string>('SSH_KEY_ENCRYPTION_KEY') ?? null;
    const sshKeyEncryptionKeyIsDefault =
      (sshKeyEncryptionKey ?? INSECURE_SSH_KEY_DEFAULT) ===
      INSECURE_SSH_KEY_DEFAULT;
    if (sshKeyEncryptionKeyIsDefault) {
      insecureDefaults.push('SSH_KEY_ENCRYPTION_KEY');
      // Warn hard, do NOT refuse — refusing would turn a confidentiality gap
      // into a resilience gap (no master backups at all). The bundle is sealed.
      this.logger.error(
        '[platform-backup] SSH_KEY_ENCRYPTION_KEY is the insecure hardcoded default — ' +
          'the /secure/keys material in this bundle is only nominally encrypted. ' +
          'Set a real key and rotate.',
      );
    }

    const sshCa = this.resolveSshCa();
    const { pat: zitadelPat, source: zitadelPatSource } =
      this.resolveZitadelPat();
    const secureKeys = await this.readSecureKeysTree();

    const manifest: KeyBundleManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      masterEnvId: input.masterEnvId,
      dek: input.dek.toString('hex'),
      encryptionKey,
      encryptionKeyFingerprint: fingerprint,
      sshKeyEncryptionKey,
      sshKeyEncryptionKeyIsDefault,
      sshCa,
      zitadelPat,
      zitadelPatSource,
      secureKeys,
      databases: input.databases,
      zitadelCovered: input.zitadelCovered,
      insecureDefaults,
    };

    const gz = gzipSync(Buffer.from(JSON.stringify(manifest), 'utf-8'));
    const ageBytes = await this.ageEncrypt(input.recipient, gz);

    this.logger.log(
      `[platform-backup] sealed key bundle (encKeyFp=${fingerprint}, secureKeyFiles=${secureKeys.length}, ` +
        `zitadelPat=${zitadelPat ? zitadelPatSource : 'none'}, insecureDefaults=${insecureDefaults.length})`,
    );

    return {
      ageBytes,
      insecureDefaults,
      encryptionKeyFingerprint: fingerprint,
    };
  }

  private resolveSshCa(): KeyBundleManifest['sshCa'] {
    const envPriv = this.configService.get<string>('SSH_CA_PRIVATE_KEY');
    const envPub = this.configService.get<string>('SSH_CA_PUBLIC_KEY');
    if (envPriv) {
      return { privateKey: envPriv, publicKey: envPub ?? null, source: 'env' };
    }
    // CLI file fallback: ~/.flui/profiles/<profile>/ca/ca_key[.pub]
    const profile = this.configService.get<string>('FLUI_PROFILE') ?? 'default';
    const caDir = path.join(os.homedir(), '.flui', 'profiles', profile, 'ca');
    try {
      const privateKey = readFileSync(path.join(caDir, 'ca_key'), 'utf-8');
      let publicKey: string | null = null;
      try {
        publicKey = readFileSync(path.join(caDir, 'ca_key.pub'), 'utf-8');
      } catch {
        publicKey = null;
      }
      return { privateKey, publicKey, source: 'cli-file' };
    } catch {
      return { privateKey: null, publicKey: null, source: 'none' };
    }
  }

  private resolveZitadelPat(): { pat: string | null; source: string } {
    const pat = this.configService.get<string>('ZITADEL_SERVICE_ACCOUNT_PAT');
    if (pat) return { pat, source: 'env' };
    // The PAT also lives in the flui-secrets K8s Secret / zitadel-bootstrap PVC;
    // capturing that path requires the control kubeconfig and is a follow-up.
    return { pat: null, source: 'none' };
  }

  /** Inline the /secure/keys tree as base64 (KBs — SSH user + CA private keys). */
  private async readSecureKeysTree(): Promise<SecureKeyFile[]> {
    const base = this.configService.get<string>(
      'SSH_KEYS_PATH',
      '/secure/keys',
    );
    const out: SecureKeyFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // path absent (e.g. local dev) — nothing to capture
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const [content, stat] = await Promise.all([
            fs.readFile(full),
            fs.stat(full),
          ]);
          out.push({
            relPath: path.relative(base, full),
            mode: (stat.mode & 0o777).toString(8),
            contentBase64: content.toString('base64'),
          });
        }
      }
    };
    await walk(base);
    return out;
  }

  private async ageEncrypt(recipient: string, data: Buffer): Promise<Buffer> {
    // age-encryption is ESM-only. A bare `import()` is rewritten by both the
    // webpack (nest build) and tsc→CommonJS toolchains; the Function indirection
    // preserves a genuine dynamic import that Node resolves at runtime.
    const importEsm = new Function(
      'return import("age-encryption")',
    ) as () => Promise<typeof import('age-encryption')>;
    const age = await importEsm();
    const encrypter = new age.Encrypter();
    encrypter.addRecipient(recipient);
    const ciphertext = await encrypter.encrypt(new Uint8Array(data));
    return Buffer.from(ciphertext);
  }
}
