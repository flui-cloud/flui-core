import { existsSync, rmSync } from 'node:fs';
import {
  openWithPlatformKey,
  sealWithPlatformKey,
} from 'src/modules/shared/encryption/platform-cipher';
import { ProfileSealedData } from './profile-sealed-data';
import {
  SealedEncryptionKey,
  chooseKey,
  legacyEncryptionKeyPath,
  legacyKeyCandidates,
  type KeyCandidate,
} from './sealed-encryption-key';
import type { ProfileKey } from './vault-crypto';

/**
 * The platform ENCRYPTION_KEY a cluster's installation received, sealed on its
 * record. Until the vault, the CLI sent every new cluster the plaintext
 * `~/.flui/encryption.key`, whatever key it sealed the local record with; a
 * later reinstall must send that same key, or the cluster's database stops
 * opening. Records from then get it at migration when the two differ.
 */
export const PLATFORM_KEY_FIELD = 'platformEncryptionKeyEncrypted';

export interface ProfileToMigrate {
  name: string;
  dir: string;
  key: ProfileKey;
}

export type ProfileMigrationOutcome =
  | { profile: string; status: 'no-data' }
  | { profile: string; status: 'up-to-date' }
  | {
      profile: string;
      status: 'migrated';
      keyFrom: string;
      resealed: number;
      stamped: number;
    }
  | { profile: string; status: 'failed'; reason: string };

export interface EncryptionKeyMigrationReport {
  profiles: ProfileMigrationOutcome[];
  legacyFile: 'absent' | 'removed' | 'kept';
}

/**
 * Moves every profile's data off the plaintext encryption key.
 *
 * Per profile: the key sealed in the profile, when there is one, stays its key;
 * otherwise the candidate that opens the most values becomes it. Values only
 * another candidate opens are re-sealed with it, the key is sealed into the
 * profile, and nothing is written for a profile holding a value no candidate
 * opens. The plaintext file is removed only when every profile holding data is
 * done. Running it again changes nothing.
 */
export function migrateEncryptionKeys(opts: {
  profiles: ProfileToMigrate[];
  baseDir: string;
  cwd: string;
}): EncryptionKeyMigrationReport {
  const candidates = legacyKeyCandidates(opts.baseDir, opts.cwd);
  const legacyPath = legacyEncryptionKeyPath(opts.baseDir);
  const legacy = candidates.find((c) => c.label === legacyPath) ?? null;

  const profiles = opts.profiles.map((p) =>
    migrateProfile(p, candidates, legacy),
  );

  let legacyFile: EncryptionKeyMigrationReport['legacyFile'] = 'absent';
  if (existsSync(legacyPath)) {
    if (profiles.every((p) => p.status !== 'failed')) {
      rmSync(legacyPath, { force: true });
      legacyFile = 'removed';
    } else {
      legacyFile = 'kept';
    }
  }
  return { profiles, legacyFile };
}

function stampLegacyKey(
  data: ProfileSealedData,
  chosen: KeyCandidate,
  legacy: KeyCandidate,
): number {
  let stamped = 0;
  for (const cluster of data.clusters()) {
    cluster.metadata ??= {};
    if (cluster.metadata[PLATFORM_KEY_FIELD]) continue;
    cluster.metadata[PLATFORM_KEY_FIELD] = sealWithPlatformKey(
      chosen.key,
      legacy.key.toString('hex'),
    );
    data.markChanged('clusters.json');
    stamped += 1;
  }
  return stamped;
}

function migrateProfile(
  profile: ProfileToMigrate,
  candidates: KeyCandidate[],
  legacy: KeyCandidate | null,
): ProfileMigrationOutcome {
  const fail = (reason: string): ProfileMigrationOutcome => ({
    profile: profile.name,
    status: 'failed',
    reason,
  });

  try {
    const sealed = new SealedEncryptionKey(profile.name, profile.dir);
    const sealedKey = sealed.exists() ? sealed.open(profile.key) : null;
    const data = new ProfileSealedData(profile.dir);
    const fields = data.fields();
    if (fields.length === 0) {
      return {
        profile: profile.name,
        status: sealedKey ? 'up-to-date' : 'no-data',
      };
    }

    const own: KeyCandidate[] = sealedKey
      ? [{ label: 'the vault', key: sealedKey }]
      : [];
    const all = [...own, ...candidates];
    const { chosen: best, openers } = chooseKey(
      fields.map((f) => f.value),
      all,
    );
    const chosen = own[0] ?? best;

    const unopened = fields.filter((_, i) => !openers[i]);
    if (!chosen || unopened.length > 0) {
      const tried = all.map((c) => c.label).join(', ') || 'no key found';
      return fail(
        `${unopened.length || fields.length} encrypted value(s) open with none of the known keys ` +
          `(${tried}), e.g. ${(unopened[0] ?? fields[0]).path}. Nothing was changed.`,
      );
    }

    let resealed = 0;
    fields.forEach((field, i) => {
      const opener = openers[i]!;
      if (opener.key.equals(chosen.key)) return;
      field.set(
        sealWithPlatformKey(
          chosen.key,
          openWithPlatformKey(opener.key, field.value),
        ),
      );
      resealed += 1;
    });

    const stamped =
      !sealedKey && legacy && !legacy.key.equals(chosen.key)
        ? stampLegacyKey(data, chosen, legacy)
        : 0;

    data.save();
    sealed.store(profile.key, chosen.key);

    if (sealedKey && resealed === 0 && stamped === 0) {
      return { profile: profile.name, status: 'up-to-date' };
    }
    return {
      profile: profile.name,
      status: 'migrated',
      keyFrom: chosen.label,
      resealed,
      stamped,
    };
  } catch (error) {
    return fail((error as Error).message);
  }
}
