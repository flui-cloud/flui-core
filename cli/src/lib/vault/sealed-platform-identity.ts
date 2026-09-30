import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProfileManager } from '../profile-manager';
import { VaultLockedError, getProfileKey } from './session-key';
import { open, seal, wipe, type ProfileKey } from './vault-crypto';
import { VaultFile, VaultNotInitialisedError } from './vault-file';

export class PlatformIdentityMissingError extends Error {
  constructor(profile: string) {
    super(
      `Profile "${profile}" keeps no platform backup key in the vault.\n` +
        '  Create one with:  flui backup platform init',
    );
    this.name = 'PlatformIdentityMissingError';
  }
}

/**
 * The age identity that opens this profile's platform backups, sealed under the
 * vault like the SSH CA, so the only secret a person carries is the vault
 * passphrase. The recipient is public and kept beside it in plaintext: enabling
 * a backup must not need the vault open.
 *
 * The vault lives on one machine and the backup exists for the day the control
 * cluster is gone, so the identity is also exported once as a recovery file
 * sealed with that same passphrase.
 */
export class SealedPlatformIdentity {
  private readonly dir: string;
  private readonly sealedPath: string;
  private readonly recipientPath: string;
  private readonly retiredDir: string;

  constructor(
    private readonly profile: string = ProfileManager.getActiveProfile(),
    profileDir: string = ProfileManager.getProfileDir(profile),
    private readonly baseDir: string = ProfileManager.BASE_DIR,
  ) {
    this.dir = join(profileDir, 'platform-backup');
    this.sealedPath = join(this.dir, 'identity.sealed');
    this.recipientPath = join(this.dir, 'recipient');
    this.retiredDir = join(this.dir, 'retired');
  }

  exists(): boolean {
    return existsSync(this.sealedPath) && existsSync(this.recipientPath);
  }

  recipient(): string | null {
    return existsSync(this.recipientPath)
      ? readFileSync(this.recipientPath, 'utf-8').trim()
      : null;
  }

  identity(): string {
    if (!existsSync(this.sealedPath)) {
      throw new PlatformIdentityMissingError(this.profile);
    }
    return open(this.requireKey(), readFileSync(this.sealedPath, 'utf-8'));
  }

  /**
   * The current identity first, then every one it replaced: backups taken
   * before a rotation stay sealed to the key of their day.
   */
  identities(): string[] {
    const key = this.requireKey();
    const retired = existsSync(this.retiredDir)
      ? readdirSync(this.retiredDir)
          .filter((f) => f.endsWith('.sealed'))
          .sort((a, b) => b.localeCompare(a))
          .map((f) =>
            open(key, readFileSync(join(this.retiredDir, f), 'utf-8')),
          )
      : [];
    return [this.identity(), ...retired];
  }

  /**
   * Written through temporary files and renames, sealed copy read back first,
   * so an interrupted run never leaves a recipient without its identity.
   */
  store(identity: string, recipient: string): void {
    const key = this.requireKey();
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
    chmodSync(this.dir, 0o700);
    const sealed = seal(key, identity);
    if (open(key, sealed) !== identity) {
      throw new Error(
        `Sealing the platform backup key of profile "${this.profile}" failed.`,
      );
    }
    if (existsSync(this.sealedPath)) {
      mkdirSync(this.retiredDir, { recursive: true, mode: 0o700 });
      renameSync(
        this.sealedPath,
        join(
          this.retiredDir,
          `${new Date().toISOString().replace(/[:.]/g, '-')}.sealed`,
        ),
      );
    }
    atomicWrite(this.sealedPath, sealed, 0o600);
    atomicWrite(this.recipientPath, `${recipient}\n`, 0o644);
  }

  /** Throws unless `passphrase` is this machine's vault passphrase. */
  verifyVaultPassphrase(passphrase: string): void {
    wipe(new VaultFile(this.baseDir).unlock(passphrase));
  }

  private requireKey(): ProfileKey {
    const key = getProfileKey(this.profile);
    if (key) return key;
    if (!new VaultFile(this.baseDir).exists()) {
      throw new VaultNotInitialisedError();
    }
    throw new VaultLockedError(this.profile);
  }
}

export function defaultRecoveryFilePath(profile: string): string {
  return join(homedir(), `flui-${profile}-platform-recovery.age`);
}

function atomicWrite(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}
