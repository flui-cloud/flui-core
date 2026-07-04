export enum DbMigrationStatus {
  PENDING = 'pending',
  PROVISIONING = 'provisioning',
  REPLICATING = 'replicating',
  SYNCED = 'synced',
  CUTOVER = 'cutover',
  RESTORING = 'restoring',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ABORTED = 'aborted',
}

export enum DbMigrationMode {
  /** Source alive: logical replication + fenced cutover. */
  LIVE = 'live',
  /** Source dead (DR): PITR restore from the off-provider repo. */
  RESTORE = 'restore',
}

export enum DbCutoverMode {
  AUTO = 'auto',
  MANUAL = 'manual',
}
