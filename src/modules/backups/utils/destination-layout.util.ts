/**
 * Where each backup engine writes inside a destination.
 *
 * Velero treats its prefix as its own and declares the whole location
 * unusable when it finds anything else at the top — which the database
 * repositories, volume exports and platform backups all put there. From this
 * layout on Velero gets `velero/` and every other engine its own folder beside
 * it. Destinations created before it keep Velero at the top until their
 * existing cluster backups have been moved (`VELERO_TOP_LEVEL_DIRS`), because
 * pointing Velero elsewhere without moving them would hide them.
 */
export const ENGINE_PREFIXED_LAYOUT = 'engine-prefixed';

/** What Velero keeps at the top of its prefix. */
export const VELERO_TOP_LEVEL_DIRS = [
  'backups',
  'restores',
  'kopia',
  'restic',
  'metadata',
  'plugins',
] as const;

interface LayoutCarrier {
  pathPrefix?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function usesEngineLayout(dest: LayoutCarrier): boolean {
  return dest.metadata?.layout === ENGINE_PREFIXED_LAYOUT;
}

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

/** Velero's prefix inside the bucket, including the destination's own. */
export function veleroBslPrefix(dest: LayoutCarrier): string | undefined {
  const prefix = join(
    trimSlashes(dest.pathPrefix),
    usesEngineLayout(dest) ? 'velero' : '',
  );
  return prefix || undefined;
}

/** A Velero backup's objects, relative to the destination's own prefix. */
export function veleroBackupKeyPrefix(
  dest: LayoutCarrier,
  backupName: string,
): string {
  return `${join(usesEngineLayout(dest) ? 'velero' : '', 'backups', backupName)}/`;
}

/**
 * Root under which volume exports are written, including the destination's
 * own prefix. Always its own folder: an export at the top is exactly what a
 * Velero prefix refuses.
 */
export function exportsRoot(
  pathPrefix: string | null | undefined,
  fallback: string,
): string {
  return join(trimSlashes(pathPrefix) || trimSlashes(fallback), 'exports');
}
