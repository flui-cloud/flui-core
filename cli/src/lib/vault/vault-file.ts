import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileManager } from '../profile-manager';
import {
  SCRYPT_PARAMS,
  deriveMasterKey,
  deriveVerifier,
  newSalt,
  verifierMatches,
  type MasterKey,
} from './vault-crypto';

export interface VaultHeader {
  version: 1;
  kdf: {
    algorithm: 'scrypt';
    N: number;
    r: number;
    p: number;
    /** base64 */
    salt: string;
  };
  /** base64; proves a passphrase without revealing it. */
  verifier: string;
  createdAt: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('That passphrase does not open this vault.');
    this.name = 'WrongPassphraseError';
  }
}

export class VaultNotInitialisedError extends Error {
  constructor() {
    super(
      'No vault on this machine yet. Run "flui vault init" to choose a passphrase before storing any credential.',
    );
    this.name = 'VaultNotInitialisedError';
  }
}

/**
 * The vault header: everything needed to turn a passphrase back into a key, and
 * nothing that helps anyone who does not have the passphrase.
 *
 * One vault covers every profile. The passphrase is asked once and profiles get
 * their own derived keys, so a person with two accounts does not carry two
 * passphrases while still keeping the accounts apart.
 *
 * The KDF parameters live in the file rather than in the code because they will
 * be raised as machines get faster. An old vault must keep opening with the
 * parameters it was written under; the code's current values apply to new
 * vaults only.
 */
export class VaultFile {
  private readonly path: string;

  constructor(baseDir: string = ProfileManager.BASE_DIR) {
    this.path = join(baseDir, 'vault.json');
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    }
  }

  get location(): string {
    return this.path;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * Creates the vault. Refuses to overwrite one that is already there: the
   * header holds the salt, and replacing it makes every sealed entry on the
   * machine permanently unreadable, with no warning and no way back.
   */
  init(passphrase: string): MasterKey {
    if (this.exists()) {
      throw new Error(
        `A vault already exists at ${this.path}. Rewriting it would make every stored credential unreadable.`,
      );
    }

    const salt = newSalt();
    const master = deriveMasterKey(passphrase, salt);
    const header: VaultHeader = {
      version: 1,
      kdf: {
        algorithm: 'scrypt',
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        salt: salt.toString('base64'),
      },
      verifier: deriveVerifier(master),
      createdAt: new Date().toISOString(),
    };

    writeFileSync(this.path, JSON.stringify(header, null, 2), { mode: 0o600 });
    return master;
  }

  unlock(passphrase: string): MasterKey {
    const header = this.read();
    const master = deriveMasterKey(
      passphrase,
      Buffer.from(header.kdf.salt, 'base64'),
      { N: header.kdf.N, r: header.kdf.r, p: header.kdf.p },
    );
    if (!verifierMatches(master, header.verifier)) {
      throw new WrongPassphraseError();
    }
    return master;
  }

  read(): VaultHeader {
    if (!this.exists()) {
      throw new VaultNotInitialisedError();
    }

    let header: VaultHeader;
    try {
      header = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch {
      throw new Error(`The vault header at ${this.path} is unreadable.`);
    }

    if (
      header.version !== 1 ||
      header.kdf?.algorithm !== 'scrypt' ||
      !header.kdf.salt
    ) {
      throw new Error(
        `The vault at ${this.path} was written by a newer version of this CLI. Upgrade to open it.`,
      );
    }
    return header;
  }
}
