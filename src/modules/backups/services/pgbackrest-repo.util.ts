import { trimSlashes } from '../utils/destination-layout.util';

export const PG_REPO_CIPHER = 'aes-256-cbc';
export const REPO_PATH_MARKER = 'FLUI_REPO_PATH=';

/**
 * Where one application's pgBackRest repository sits and whether it is
 * encrypted, as recorded on the artifact that was written into it.
 *
 * pgBackRest cannot turn encryption on for a repository that already exists,
 * so the encrypted one is a new repository beside the old: the plaintext one
 * holds `archive/` and `backup/` directly under `pgbackrest/<appId>/`, the
 * encrypted one lives under `pgbackrest/<appId>/encrypted/`.
 */
export interface PgRepositoryRecord {
  /** Relative to the destination's own `pathPrefix`, with a trailing slash. */
  objectKeyPrefix: string;
  /** What `pgbackrest info` reported after the backup, not what was asked. */
  cipher: string;
}

export function legacyRepoPrefix(appId: string): string {
  return `pgbackrest/${appId}/`;
}

export function encryptedRepoPrefix(appId: string): string {
  return `pgbackrest/${appId}/encrypted/`;
}

/** The only objects a plaintext repository owns, and so the only ones retired. */
export function legacyRepoObjectPrefixes(appId: string): string[] {
  const root = legacyRepoPrefix(appId);
  return [`${root}archive/`, `${root}backup/`];
}

/** `repo1-path` for a relative prefix inside a destination. */
export function repoPathIn(
  pathPrefix: string | null | undefined,
  objectKeyPrefix: string,
): string {
  const prefix = trimSlashes(pathPrefix);
  return `/${[prefix, trimSlashes(objectKeyPrefix)].filter(Boolean).join('/')}`;
}

/**
 * The repository an artifact was written into. Rows from before encryption
 * carry nothing, and every one of them was written to the plaintext layout.
 */
export function repositoryOf(
  appId: string,
  summary: Record<string, unknown> | null | undefined,
): { objectKeyPrefix: string; encrypted: boolean } {
  const recorded = summary?.repository as
    | Partial<PgRepositoryRecord>
    | undefined;
  if (recorded?.objectKeyPrefix) {
    return {
      objectKeyPrefix: recorded.objectKeyPrefix,
      encrypted: recorded.cipher === PG_REPO_CIPHER,
    };
  }
  return { objectKeyPrefix: legacyRepoPrefix(appId), encrypted: false };
}

export function isEncryptedRepository(
  summary: Record<string, unknown> | null | undefined,
): boolean {
  return (
    (summary?.repository as Partial<PgRepositoryRecord> | undefined)?.cipher ===
    PG_REPO_CIPHER
  );
}

/** pgBackRest's configuration is line-based: a newline would add options. */
export function assertConfigValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `${name} contains a line break and cannot be written into the pgBackRest configuration`,
    );
  }
  return value;
}

/** The stanza's cipher from `pgbackrest info --output=json`, or null. */
export function parseRepoCipher(json: string, stanza: string): string | null {
  try {
    const parsed = JSON.parse(json) as Array<{
      name?: string;
      cipher?: string;
      repo?: Array<{ cipher?: string }>;
    }>;
    const found = Array.isArray(parsed)
      ? parsed.find((s) => s?.name === stanza)
      : undefined;
    return found?.cipher ?? found?.repo?.[0]?.cipher ?? null;
  } catch {
    return null;
  }
}

/**
 * The live pod reports on the repository its configuration names. Answering
 * for an artifact written into the other one would validate a restore against
 * the wrong chain, so the caller is told it cannot check this one live.
 */
export function assertLiveRepository(
  appId: string,
  artifactSummary: Record<string, unknown>,
  execOutput: string,
): void {
  const live = trimSlashes(
    new RegExp(String.raw`${REPO_PATH_MARKER}([^\n]*)`).exec(execOutput)?.[1],
  );
  const expected = trimSlashes(
    repositoryOf(appId, artifactSummary).objectKeyPrefix,
  );
  if (!live || (live !== expected && !live.endsWith(`/${expected}`))) {
    throw new Error(
      `the running database ships to ${live || 'no repository'}, not to the repository this backup was written to`,
    );
  }
}
