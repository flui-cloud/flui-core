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
  VELERO_REBUILD = 'velero_rebuild',
  OS_SNAPSHOT = 'os_snapshot',
  PG_PITR = 'pg_pitr',
}

export enum PreDeploySnapshotPolicy {
  REQUIRED = 'required',
  BEST_EFFORT = 'best_effort',
}

/**
 * Where a restore puts what it recovers — the one word every restore path must
 * state, because the three engines default differently and none of them said so.
 *
 * A Velero restore with no policy set fills gaps and leaves everything else
 * untouched: neither of these, and nobody chose it. A logical `db restore`
 * overwrites in place. A PITR recovery builds a new install beside the source.
 * Recording the choice makes "did this replace my data?" answerable from the
 * row instead of from whoever ran it.
 */
export enum RestorePlacement {
  /** Beside the original: a new namespace, a new cluster, or a new install. */
  NEW = 'new',
  /** Onto the original, replacing what is there. */
  EXISTING = 'existing',
}
