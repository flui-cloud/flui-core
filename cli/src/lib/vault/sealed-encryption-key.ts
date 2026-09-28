import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  PLATFORM_KEY_BYTES,
  opensWithPlatformKey,
  parsePlatformKeyHex,
} from 'src/modules/shared/encryption/platform-cipher';
import { ProfileManager } from '../profile-manager';
import { open, seal, type ProfileKey } from './vault-crypto';

export const LEGACY_ENCRYPTION_KEY_FILE = 'encryption.key';

/**
 * The key every `*Encrypted` value of a profile's data files is sealed with,
 * itself sealed with the profile's vault key.
 *
 * Before the vault it lived in plaintext at `~/.flui/encryption.key`, beside
 * the data it opens — anyone who could read one could read the other.
 */
export class SealedEncryptionKey {
  readonly sealedPath: string;

  constructor(
    private readonly profile: string = ProfileManager.getActiveProfile(),
    profileDir: string = ProfileManager.getProfileDir(profile),
  ) {
    this.sealedPath = join(profileDir, 'encryption.key.sealed');
  }

  exists(): boolean {
    return existsSync(this.sealedPath);
  }

  open(key: ProfileKey): Buffer {
    const hex = open(key, readFileSync(this.sealedPath, 'utf-8'));
    const parsed = parsePlatformKeyHex(hex);
    if (!parsed) {
      throw new Error(
        `The sealed encryption key of profile "${this.profile}" is malformed.`,
      );
    }
    return parsed;
  }

  create(key: ProfileKey): Buffer {
    const fresh = randomBytes(PLATFORM_KEY_BYTES);
    this.store(key, fresh);
    return fresh;
  }

  /**
   * Seals `platformKey` into the profile. A different key already sealed here
   * is never replaced: everything the profile holds opens with that one.
   */
  store(key: ProfileKey, platformKey: Buffer): void {
    if (this.exists()) {
      if (this.open(key).equals(platformKey)) return;
      throw new Error(
        `Profile "${this.profile}" already has a different encryption key sealed in the vault.`,
      );
    }
    const tmp = `${this.sealedPath}.tmp-${process.pid}`;
    writeFileSync(tmp, seal(key, platformKey.toString('hex')), { mode: 0o600 });
    if (open(key, readFileSync(tmp, 'utf-8')) !== platformKey.toString('hex')) {
      rmSync(tmp, { force: true });
      throw new Error(
        `Sealing the encryption key of profile "${this.profile}" failed.`,
      );
    }
    renameSync(tmp, this.sealedPath);
  }
}

export interface KeyCandidate {
  label: string;
  key: Buffer;
}

/** `ENCRYPTION_KEY=<64 hex>` out of a dotenv file, or null. */
export function encryptionKeyFromDotenv(file: string): Buffer | null {
  if (!existsSync(file)) return null;
  const match =
    /^[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*(?:export\s+)?ENCRYPTION_KEY\s*=\s*["']?([0-9a-fA-F]{64})["']?\s*$/m.exec(
      readFileSync(file, 'utf-8'),
    );
  return match ? parsePlatformKeyHex(match[1]) : null;
}

export function legacyEncryptionKeyPath(baseDir: string): string {
  return join(baseDir, LEGACY_ENCRYPTION_KEY_FILE);
}

/**
 * The keys an older CLI may have sealed a profile's data with: the plaintext
 * file, and — because the CLI loaded `~/.flui/.env` and `<cwd>/.env`, whose
 * ENCRYPTION_KEY won over the file — the keys those two hold. Duplicates are
 * dropped, keeping the first label.
 */
export function legacyKeyCandidates(
  baseDir: string,
  cwd: string,
): KeyCandidate[] {
  const out: KeyCandidate[] = [];
  const add = (label: string, key: Buffer | null): void => {
    if (key && !out.some((c) => c.key.equals(key))) out.push({ label, key });
  };
  const legacyPath = legacyEncryptionKeyPath(baseDir);
  add(
    legacyPath,
    existsSync(legacyPath)
      ? parsePlatformKeyHex(readFileSync(legacyPath, 'utf-8'))
      : null,
  );
  add(join(baseDir, '.env'), encryptionKeyFromDotenv(join(baseDir, '.env')));
  add(join(cwd, '.env'), encryptionKeyFromDotenv(join(cwd, '.env')));
  return out;
}

export interface KeyChoice {
  chosen: KeyCandidate | null;
  /** For each value, the first candidate that opens it, or null. */
  openers: Array<KeyCandidate | null>;
}

/**
 * The candidate that opens the most values; ties go to the earlier one, so the
 * plaintext file wins over a `.env` key that opens as much.
 */
export function chooseKey(
  values: string[],
  candidates: KeyCandidate[],
): KeyChoice {
  const opens = candidates.map((c) =>
    values.map((v) => opensWithPlatformKey(c.key, v)),
  );
  let best = -1;
  let bestCount = 0;
  opens.forEach((row, i) => {
    const count = row.filter(Boolean).length;
    if (count > bestCount) {
      best = i;
      bestCount = count;
    }
  });
  return {
    chosen: best >= 0 ? candidates[best] : null,
    openers: values.map((_, v) => {
      const i = opens.findIndex((row) => row[v]);
      return i >= 0 ? candidates[i] : null;
    }),
  };
}
