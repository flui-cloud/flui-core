export enum BackupEngineClass {
  DATABASE = 'database',
  PLATFORM = 'platform',
  /**
   * One volume, copied on demand — the copy-pod primitive behind
   * `flui backup take`. Its sink decides where the copy lands: an S3
   * destination (durable, survives the cluster) or a sibling PVC in the
   * cluster (fast, dies with the application).
   */
  VOLUME_COPY = 'volume_copy',
}

/**
 * Classes rows may still carry but nothing creates or runs any more. They stay
 * in the column's type because Postgres cannot drop an enum value that rows
 * use, and a column declared without them would have `synchronize` try to.
 * See `1790000000018-RemoveClusterBackupEngine`.
 */
export const RETIRED_ENGINE_CLASSES = ['volume'] as const;

export const STORED_ENGINE_CLASSES: string[] = [
  ...Object.values(BackupEngineClass),
  ...RETIRED_ENGINE_CLASSES,
];

export function isRetiredEngineClass(
  value: string | null | undefined,
): boolean {
  return (RETIRED_ENGINE_CLASSES as readonly string[]).includes(value ?? '');
}

/** Why a policy of a retired class was paused; it cannot be resumed. */
export const ENGINE_REMOVED_REASON = 'engine_removed';
