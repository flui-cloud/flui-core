import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProfileManager } from '../profile-manager';
import { VaultLockedError, getProfileKey } from './session-key';
import { open, seal, type ProfileKey } from './vault-crypto';
import { VaultFile, VaultNotInitialisedError } from './vault-file';

/**
 * Flui's own SSH key — the fallback that gets a BYOS host ready when the
 * operator has no key of their own the host trusts — sealed per profile.
 *
 * Older CLIs kept it in plaintext at `~/.flui/ssh/id_rsa`, and cluster records
 * name that path as the key an installation used. The path stays the key's
 * name: whoever holds it as a path gets a private copy, opened from the vault
 * for the length of one use.
 */
export class SealedSshKey {
  private readonly dir: string;
  private readonly sealedPath: string;
  private readonly pubPath: string;
  private readonly legacyPath: string;

  constructor(
    private readonly profile: string = ProfileManager.getActiveProfile(),
    profileDir: string = ProfileManager.getProfileDir(profile),
    private readonly baseDir: string = ProfileManager.BASE_DIR,
  ) {
    this.dir = join(profileDir, 'ssh');
    this.sealedPath = join(this.dir, 'id_rsa.sealed');
    this.pubPath = join(this.dir, 'id_rsa.pub');
    this.legacyPath = join(baseDir, 'ssh', 'id_rsa');
  }

  /** The path cluster records use to name this key. */
  get reference(): string {
    return this.legacyPath;
  }

  get publicKeyPath(): string {
    return this.hasLegacy() ? `${this.legacyPath}.pub` : this.pubPath;
  }

  isManaged(keyPath: string): boolean {
    return resolve(keyPath) === resolve(this.legacyPath);
  }

  hasLegacy(): boolean {
    return existsSync(this.legacyPath) && existsSync(`${this.legacyPath}.pub`);
  }

  isSealed(): boolean {
    return existsSync(this.sealedPath) && existsSync(this.pubPath);
  }

  exists(): boolean {
    return this.hasLegacy() || this.isSealed();
  }

  publicKey(): string {
    return readFileSync(this.publicKeyPath, 'utf-8').trim();
  }

  create(): string {
    const key = this.requireKey();
    this.ensureDir();
    this.withScratchDir((scratch) => {
      const keyPath = join(scratch, 'id_rsa');
      execFileSync(
        'ssh-keygen',
        [
          '-t',
          'rsa',
          '-b',
          '4096',
          '-f',
          keyPath,
          '-N',
          '',
          '-C',
          `flui-cli@${hostname()}`,
        ],
        { stdio: 'pipe' },
      );
      writeFileSync(
        this.sealedPath,
        seal(key, readFileSync(keyPath, 'utf-8')),
        {
          mode: 0o600,
        },
      );
      writeFileSync(this.pubPath, readFileSync(`${keyPath}.pub`, 'utf-8'), {
        mode: 0o644,
      });
    });
    return this.publicKey();
  }

  /** A private copy of the key for `use`, removed when it returns or throws. */
  async withPrivateKeyFile<T>(
    use: (keyPath: string) => Promise<T> | T,
  ): Promise<T> {
    if (existsSync(this.legacyPath)) return use(this.legacyPath);
    if (!existsSync(this.sealedPath)) {
      throw new Error(`No Flui SSH key found for profile "${this.profile}".`);
    }
    const privateKey = open(
      this.requireKey(),
      readFileSync(this.sealedPath, 'utf-8'),
    );
    const scratch = this.scratchDir();
    try {
      const keyPath = join(scratch, 'id_rsa');
      writeFileSync(keyPath, privateKey, { mode: 0o600 });
      return await use(keyPath);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Seals the plaintext key of an older CLI into this profile, leaving the
   * plaintext in place: it is shared by every profile, and only the caller that
   * sealed it into all of them may remove it.
   */
  sealLegacy(key: ProfileKey): boolean {
    if (!this.hasLegacy()) return false;
    const plaintext = readFileSync(this.legacyPath, 'utf-8');
    if (existsSync(this.sealedPath)) {
      if (open(key, readFileSync(this.sealedPath, 'utf-8')) === plaintext) {
        return false;
      }
      throw new Error(
        `Profile "${this.profile}" already holds a different Flui SSH key than ${this.legacyPath}. ` +
          'Both were left as they are.',
      );
    }
    this.ensureDir();
    writeFileSync(this.sealedPath, seal(key, plaintext), { mode: 0o600 });
    if (open(key, readFileSync(this.sealedPath, 'utf-8')) !== plaintext) {
      rmSync(this.sealedPath, { force: true });
      throw new Error(
        `Sealing the Flui SSH key of profile "${this.profile}" failed.`,
      );
    }
    writeFileSync(
      this.pubPath,
      readFileSync(`${this.legacyPath}.pub`, 'utf-8'),
      {
        mode: 0o644,
      },
    );
    return true;
  }

  removeLegacy(): void {
    rmSync(this.legacyPath, { force: true });
    rmSync(`${this.legacyPath}.pub`, { force: true });
  }

  private requireKey(): ProfileKey {
    const key = getProfileKey(this.profile);
    if (key) return key;
    if (!new VaultFile(this.baseDir).exists())
      throw new VaultNotInitialisedError();
    throw new VaultLockedError(this.profile);
  }

  private ensureDir(): void {
    if (!existsSync(this.dir))
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  private scratchDir(): string {
    const scratch = mkdtempSync(join(tmpdir(), 'flui-ssh-'));
    chmodSync(scratch, 0o700);
    return scratch;
  }

  private withScratchDir<T>(use: (dir: string) => T): T {
    const scratch = this.scratchDir();
    try {
      return use(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
