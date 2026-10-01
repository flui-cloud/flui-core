export const BACKUP_QUEUE = 'backup';

export const RCLONE_IMAGE = 'rclone/rclone:1.68';

export const BACKUP_JOB_TYPES = {
  RUN_DB_BACKUP: 'run-db-backup',
  RUN_DB_RESTORE: 'run-db-restore',
  REPLICATE_BACKUP: 'replicate-backup',
  HEALTH_CHECK_DESTINATION: 'health-check-destination',
  ENABLE_ETCD_SNAPSHOTS: 'enable-etcd-snapshots',
  CREATE_PROVIDER_SNAPSHOT: 'create-provider-snapshot',
  RUN_PLATFORM_BACKUP: 'run-platform-backup',
  RUN_VOLUME_COPY: 'run-volume-copy',
  PROTECT_CLUSTER: 'protect-cluster',
  PROTECT_NEW_APPLICATION: 'protect-new-application',
  PRE_DEPLOY_BACKUP: 'pre-deploy-snapshot-trigger',
  APP_VOLUME_BACKUP: 'app-volume-backup',
  UNINSTALL_VELERO: 'uninstall-velero',
} as const;

export const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
