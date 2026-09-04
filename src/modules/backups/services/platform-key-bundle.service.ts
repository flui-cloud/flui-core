import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { gzipSync } from 'node:zlib';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { RETIRED_DEFAULT_KEY_HEX } from '../../access/services/key-storage.service';

// If this is the live key, the SSH/CA material under /secure/keys is only
// nominally encrypted. Imported rather than copied so the two cannot drift.
const INSECURE_SSH_KEY_DEFAULT = RETIRED_DEFAULT_KEY_HEX;

/**
 * A Secret that exists only inside the cluster and that a rebuilt installation
 * cannot regenerate: `zitadel-secrets` holds the masterkey without which a
 * restored Zitadel database cannot decrypt itself, and the role passwords the
 * restored dump expects. Captured verbatim so a rebuild can put them back.
 */
interface CapturedClusterSecret {
  namespace: string;
  name: string;
  data: Record<string, string>;
}

/** Where the rebuild-critical secrets live on a Flui control plane. */
const REBUILD_CRITICAL_SECRETS: ReadonlyArray<{
  namespace: string;
  name: string;
}> = [
  { namespace: 'flui-system', name: 'zitadel-secrets' },
  { namespace: 'flui-system', name: 'flui-secrets' },
];

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
  clusterSecrets: CapturedClusterSecret[];
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
    private readonly kubernetesService: KubernetesService,
  ) {}

  async assemble(input: {
    recipient: string;
    dek: Buffer;
    masterEnvId: string;
    databases: string[];
    zitadelCovered: boolean;
    /** Control-plane kubeconfig — the only way to reach the in-cluster secrets. */
    kubeconfig?: string;
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
    const clusterSecrets = await this.captureClusterSecrets(input.kubeconfig);
    const { pat: zitadelPat, source: zitadelPatSource } =
      this.resolveZitadelPat(clusterSecrets);
    const secureKeys = await this.readSecureKeysTree();

    // A bundle without the Zitadel masterkey restores a database Zitadel cannot
    // read: every user and every OIDC client is gone. That is a silent, total
    // loss of the identity layer, so it is called out rather than logged once.
    const hasMasterkey = clusterSecrets.some(
      (s) => s.name === 'zitadel-secrets' && s.data.masterkey,
    );
    if (input.zitadelCovered && !hasMasterkey) {
      insecureDefaults.push('ZITADEL_MASTERKEY_MISSING');
      this.logger.error(
        '[platform-backup] the Zitadel masterkey could not be captured — a restore ' +
          'from this bundle will load the Zitadel database but be unable to decrypt it. ' +
          'Every user and OIDC client would be unrecoverable.',
      );
    }

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
      clusterSecrets,
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

  private resolveZitadelPat(clusterSecrets: CapturedClusterSecret[]): {
    pat: string | null;
    source: string;
  } {
    const pat = this.configService.get<string>('ZITADEL_SERVICE_ACCOUNT_PAT');
    if (pat) return { pat, source: 'env' };
    // The bootstrap deliberately keeps the PAT out of the API's env (OIDC
    // provisions it at runtime), so the Secret is the normal source, not a
    // fallback.
    const fromSecret = clusterSecrets.find((s) => s.name === 'flui-secrets')
      ?.data?.ZITADEL_SERVICE_ACCOUNT_PAT;
    if (fromSecret)
      return { pat: fromSecret, source: 'flui-system/flui-secrets' };
    return { pat: null, source: 'none' };
  }

  /**
   * Reads the Secrets a rebuilt installation cannot regenerate. Best effort per
   * secret: a control plane in local-auth mode has no `zitadel-secrets`, and
   * that is not a failure — but an unreadable cluster is reported, because
   * silently sealing a bundle that is missing the masterkey is exactly the
   * failure this capture exists to prevent.
   */
  private async captureClusterSecrets(
    kubeconfig?: string,
  ): Promise<CapturedClusterSecret[]> {
    if (!kubeconfig) {
      this.logger.warn(
        '[platform-backup] no control kubeconfig available — in-cluster secrets ' +
          '(Zitadel masterkey, role passwords) are NOT in this bundle.',
      );
      return [];
    }
    const captured: CapturedClusterSecret[] = [];
    for (const ref of REBUILD_CRITICAL_SECRETS) {
      try {
        const data = await this.kubernetesService.readSecretData(
          kubeconfig,
          ref.name,
          ref.namespace,
        );
        if (data) captured.push({ ...ref, data });
      } catch (err: any) {
        this.logger.error(
          `[platform-backup] could not read ${ref.namespace}/${ref.name}: ${err?.message}`,
        );
      }
    }
    return captured;
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
