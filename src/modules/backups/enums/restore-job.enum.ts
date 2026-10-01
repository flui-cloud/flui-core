export enum RestoreJobStatus {
  PENDING = 'pending',
  PREVIEWING = 'previewing',
  RESTORING = 'restoring',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum RestoreTargetKind {
  CLUSTER = 'cluster',
  NAMESPACE = 'namespace',
  APPLICATION = 'application',
  CONTROL = 'control',
  /** @deprecated legacy alias for CONTROL; accepted for back-compat. */
  OBSERVABILITY = 'observability',
  /** pgBackRest PITR into a fresh catalog install (never in-place). */
  DATABASE = 'database',
}

export enum RestoreStrategy {
  OS_SNAPSHOT = 'os_snapshot',
  PG_PITR = 'pg_pitr',
  /** A MariaDB base backup brought forward by its binary logs. */
  MARIADB_PITR = 'mariadb_pitr',
  /** A logical dump loaded into a new database. */
  LOGICAL_DUMP = 'logical_dump',
}

/**
 * Strategies older restore rows may carry; kept in the column's type for the
 * same reason as `RETIRED_ENGINE_CLASSES`.
 */
export const RETIRED_RESTORE_STRATEGIES = ['velero_rebuild'] as const;

export const STORED_RESTORE_STRATEGIES: string[] = [
  ...Object.values(RestoreStrategy),
  ...RETIRED_RESTORE_STRATEGIES,
];

export enum PreDeploySnapshotPolicy {
  REQUIRED = 'required',
  BEST_EFFORT = 'best_effort',
}

/**
 * Where a restore puts what it recovers — the one word every restore path must
 * state, because the engines default differently.
 *
 * A logical `db restore` overwrites in place. A PITR recovery builds a new
 * install beside the source. Recording the choice makes "did this replace my
 * data?" answerable from the row instead of from whoever ran it.
 */
export enum RestorePlacement {
  /** Beside the original: a new namespace, a new cluster, or a new install. */
  NEW = 'new',
  /** Onto the original, replacing what is there. */
  EXISTING = 'existing',
}
