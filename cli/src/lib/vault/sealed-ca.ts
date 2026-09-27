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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileManager } from '../profile-manager';
import { getProfileKey } from './session-key';
import { open, seal, type ProfileKey } from './vault-crypto';
import { VaultFile, VaultNotInitialisedError } from './vault-file';

export class CaSealedError extends Error {
  constructor(profile: string) {
    super(
      `The SSH CA of profile "${profile}" is sealed in the vault, and the vault is locked.\n` +
        '  Unlock it with:  flui vault unlock',
    );
    this.name = 'CaSealedError';
  }
}

/**
 * The profile's SSH certificate authority, kept sealed under the vault.
 *
 * The private key signs root access to every node of the profile, so it gets
 * the same protection as the provider credentials: sealed with the profile key,
 * opened only in a process that holds it. `ssh-keygen -s` needs a file, so a
 * signing gets a private copy in a 0700 temp directory that is removed as soon
 * as the call returns.
 */
export class SealedCa {
  private readonly dir: string;
  private readonly sealedPath: string;
  private readonly plainPath: string;
  private readonly pubPath: string;

  constructor(
    private readonly profile: string = ProfileManager.getActiveProfile(),
    profileDir: string = ProfileManager.getProfileDir(profile),
  ) {
    this.dir = join(profileDir, 'ca');
    this.sealedPath = join(this.dir, 'ca_key.sealed');
    this.plainPath = join(this.dir, 'ca_key');
    this.pubPath = join(this.dir, 'ca_key.pub');
  }

  get publicKeyPath(): string {
    return this.pubPath;
  }

  exists(): boolean {
    return (
      existsSync(this.pubPath) &&
      (existsSync(this.sealedPath) || existsSync(this.plainPath))
    );
  }

  isSealed(): boolean {
    return existsSync(this.sealedPath) && !existsSync(this.plainPath);
  }

  hasPlaintextKey(): boolean {
    return existsSync(this.plainPath);
  }

  publicKey(): string {
    return readFileSync(this.pubPath, 'utf-8').trim();
  }

  create(): string {
    const key = this.requireKey();
    this.ensureDir();
    this.withScratchDir((scratch) => {
      const keyPath = join(scratch, 'ca_key');
      execFileSync(
        'ssh-keygen',
        ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'flui-ca-cli'],
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

  privateKey(): string {
    if (existsSync(this.plainPath)) this.sealExisting(this.requireKey());
    if (!existsSync(this.sealedPath)) {
      throw new Error(`No SSH CA found for profile "${this.profile}".`);
    }
    return open(this.requireKey(), readFileSync(this.sealedPath, 'utf-8'));
  }

  withPrivateKeyFile<T>(use: (keyPath: string) => T): T {
    const privateKey = this.privateKey();
    return this.withScratchDir((scratch) => {
      const keyPath = join(scratch, 'ca_key');
      writeFileSync(keyPath, privateKey, { mode: 0o600 });
      return use(keyPath);
    });
  }

  /**
   * Replaces a plaintext CA left by an older CLI with its sealed form. The
   * sealed copy is written and read back before the plaintext is removed, so an
   * interrupted run never leaves the profile without a CA.
   *
   * A plaintext CA next to a sealed one is not always the same key: a CLI from
   * before the vault, still running, finds no `ca_key` and mints a fresh one.
   * Sealing that over the original would lock the operator out of every node, so
   * a mismatch stops here and leaves both files for a person to judge.
   */
  sealExisting(key: ProfileKey): boolean {
    if (!existsSync(this.plainPath)) return false;
    const plaintext = readFileSync(this.plainPath, 'utf-8');
    if (existsSync(this.sealedPath)) {
      const sealed = open(key, readFileSync(this.sealedPath, 'utf-8'));
      if (sealed.trim() !== plaintext.trim()) {
        throw new Error(
          `Profile "${this.profile}" holds two different SSH CAs: ${this.plainPath} (plaintext) and ` +
            `${this.sealedPath} (sealed). The plaintext one was probably created by an older Flui CLI ` +
            'still running; nodes trust the sealed one. Stop older flui processes and remove the ' +
            'plaintext file once you have checked it is not the CA your nodes trust.',
        );
      }
      rmSync(this.plainPath, { force: true });
      return true;
    }
    writeFileSync(this.sealedPath, seal(key, plaintext), { mode: 0o600 });
    if (open(key, readFileSync(this.sealedPath, 'utf-8')) !== plaintext) {
      rmSync(this.sealedPath, { force: true });
      throw new Error(
        `Sealing the SSH CA of profile "${this.profile}" failed.`,
      );
    }
    rmSync(this.plainPath, { force: true });
    return true;
  }

  private requireKey(): ProfileKey {
    const key = getProfileKey(this.profile);
    if (key) return key;
    if (!new VaultFile().exists()) throw new VaultNotInitialisedError();
    throw new CaSealedError(this.profile);
  }

  private ensureDir(): void {
    if (!existsSync(this.dir))
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  private withScratchDir<T>(use: (dir: string) => T): T {
    const scratch = mkdtempSync(join(tmpdir(), 'flui-ca-'));
    chmodSync(scratch, 0o700);
    try {
      return use(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
