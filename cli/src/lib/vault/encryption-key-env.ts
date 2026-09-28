import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENCRYPTION_KEY_UNAVAILABLE_VAR } from 'src/modules/shared/encryption/platform-cipher';
import { ProfileManager } from '../profile-manager';
import { VaultLockedError, getProfileKey } from './session-key';
import { VaultNotInitialisedError } from './vault-file';
import { ProfileSealedData } from './profile-sealed-data';
import {
  SealedEncryptionKey,
  chooseKey,
  legacyKeyCandidates,
} from './sealed-encryption-key';
import type { ProfileKey } from './vault-crypto';

export type EncryptionKeyResolution =
  | {
      key: Buffer;
      source: 'vault' | 'new' | 'legacy';
      label?: string;
    }
  | { unavailable: string };

export interface ResolveOptions {
  profile?: string;
  profileDir?: string;
  baseDir?: string;
  cwd?: string;
  profileKey?: ProfileKey | null;
}

/**
 * Which key the CLI's encryption service gets for this profile.
 *
 * In order: the key sealed in the profile (needs the vault open); a key an
 * older CLI used, while the profile has not been migrated yet; a fresh key,
 * sealed at once, for a profile that holds nothing sealed. Anything else is
 * "unavailable", with the sentence that tells the operator what to do.
 */
export function resolveCliEncryptionKey(
  opts: ResolveOptions = {},
): EncryptionKeyResolution {
  const profile = opts.profile ?? ProfileManager.getActiveProfile();
  const profileDir = opts.profileDir ?? ProfileManager.getProfileDir(profile);
  const baseDir = opts.baseDir ?? ProfileManager.BASE_DIR;
  const { profileKey = getProfileKey(profile) } = opts;

  const sealed = new SealedEncryptionKey(profile, profileDir);
  const locked = (): EncryptionKeyResolution => ({
    unavailable: existsSync(join(baseDir, 'vault.json'))
      ? new VaultLockedError(profile).message
      : new VaultNotInitialisedError().message,
  });

  if (sealed.exists()) {
    if (!profileKey) return locked();
    try {
      return { key: sealed.open(profileKey), source: 'vault' };
    } catch (error) {
      return {
        unavailable: `The encryption key of profile "${profile}" could not be opened: ${
          (error as Error).message
        }`,
      };
    }
  }

  let values: string[] = [];
  try {
    values = new ProfileSealedData(profileDir).fields().map((f) => f.value);
  } catch {
    values = [];
  }

  const candidates = legacyKeyCandidates(baseDir, opts.cwd ?? process.cwd());
  if (candidates.length > 0) {
    const { chosen } = chooseKey(values, candidates);
    const legacyFile = candidates.find((c) =>
      c.label.endsWith('encryption.key'),
    );
    const pick = chosen ?? legacyFile;
    if (pick) return { key: pick.key, source: 'legacy', label: pick.label };
  }

  if (values.length > 0) {
    return {
      unavailable:
        `Profile "${profile}" holds encrypted data that no known key opens.\n` +
        '  Run "flui vault unlock" to move it under the vault; it reports what it could not open.',
    };
  }

  if (!profileKey) return locked();
  return { key: sealed.create(profileKey), source: 'new' };
}

/**
 * Runs `boot` with the resolved key in `ENCRYPTION_KEY`, or with the reason
 * there is none in FLUI_ENCRYPTION_KEY_UNAVAILABLE.
 *
 * Assigned outright, not defaulted: by the time this runs the CLI module has
 * already copied `<cwd>/.env` into the environment, and a key taken from
 * whatever directory the command was typed in is how one profile ended up
 * sealed under two keys. Restored afterwards so the key does not stay in the
 * environment every child process inherits.
 */
export async function withCliEncryptionKey<T>(
  boot: () => Promise<T>,
  resolve: () => EncryptionKeyResolution = () => resolveCliEncryptionKey(),
): Promise<T> {
  const saved = {
    key: process.env.ENCRYPTION_KEY,
    unavailable: process.env[ENCRYPTION_KEY_UNAVAILABLE_VAR],
  };
  const resolution = resolve();
  if ('key' in resolution) {
    process.env.ENCRYPTION_KEY = resolution.key.toString('hex');
    delete process.env[ENCRYPTION_KEY_UNAVAILABLE_VAR];
  } else {
    delete process.env.ENCRYPTION_KEY;
    process.env[ENCRYPTION_KEY_UNAVAILABLE_VAR] = resolution.unavailable;
  }
  try {
    return await boot();
  } finally {
    restore('ENCRYPTION_KEY', saved.key);
    restore(ENCRYPTION_KEY_UNAVAILABLE_VAR, saved.unavailable);
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
