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
