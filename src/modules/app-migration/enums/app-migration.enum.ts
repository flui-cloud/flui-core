export enum AppMigrationStatus {
  PENDING = 'pending',
  /** Workload being materialized on the destination cluster. */
  PROVISIONING = 'provisioning',
  /** Workload Ready on the destination; cutover pending (source still serves). */
  READY = 'ready',
  /** Rebinding the app + flipping DNS to the destination. */
  CUTOVER = 'cutover',
  /** Served from the destination; the source still forwards clients that resolve it. */
  BRIDGING = 'bridging',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ABORTED = 'aborted',
}

export enum AppCutoverMode {
  AUTO = 'auto',
  MANUAL = 'manual',
}
