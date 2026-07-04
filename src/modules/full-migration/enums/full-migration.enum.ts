export enum FullMigrationStatus {
  PENDING = 'pending',
  /** DB child replicating; parked at SYNCED. */
  DB_REPLICATING = 'db_replicating',
  /** App child staging on the destination at replicas 0. */
  APP_STAGING = 'app_staging',
  /** DB synced + app staged; joint cutover pending. */
  READY = 'ready',
  /** Joint cutover in flight. */
  CUTOVER = 'cutover',
  COMPLETED = 'completed',
  /** Failure BEFORE the DB promote (point of no return) — rolled back. */
  FAILED = 'failed',
  /** Failure AFTER promote — never rolled back; cutover is re-runnable. */
  FAILED_FORWARD = 'failed_forward',
  ABORTED = 'aborted',
}

export enum FullCutoverMode {
  AUTO = 'auto',
  MANUAL = 'manual',
}

export enum FullStagingMode {
  /** Stage the app at replicas 0 (no dst-wired pods pre-promote); safe default. */
  SCALED_DOWN = 'scaled-down',
  /** Stage at full replicas against a FENCED destination — the app must boot and pass
   * readiness against a read-only DB (no write-migrations-on-start); shrinks the write pause. */
  LIVE_FENCED = 'live-fenced',
}
