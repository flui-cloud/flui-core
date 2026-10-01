/**
 * Where each backup engine writes inside a destination: every engine in its
 * own folder under the destination's prefix. Destinations record the layout
 * they were created with in `metadata.layout`.
 */
export const ENGINE_PREFIXED_LAYOUT = 'engine-prefixed';

export function trimSlashes(value: string | null | undefined): string {
  if (!value) return '';
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

/**
 * Root under which volume exports are written, including the destination's
 * own prefix, in a folder of their own.
 */
export function exportsRoot(
  pathPrefix: string | null | undefined,
  fallback: string,
): string {
  return join(trimSlashes(pathPrefix) || trimSlashes(fallback), 'exports');
}

/**
 * One application's kopia repository, relative to the destination's own
 * prefix, beside `pgbackrest/`, `mariadb/`, `dumps/` and `exports/`. One
 * repository per application, so a key derived for that application opens
 * that repository and nothing else.
 */
export function kopiaRepositoryPrefix(appId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(appId)) {
    throw new Error(`"${appId}" cannot name a kopia repository`);
  }
  return `kopia/${appId}/`;
}

/** The same repository as a full key prefix in the bucket, as kopia takes it. */
export function kopiaBucketPrefix(
  pathPrefix: string | null | undefined,
  appId: string,
): string {
  return `${join(trimSlashes(pathPrefix), kopiaRepositoryPrefix(appId).slice(0, -1))}/`;
}
