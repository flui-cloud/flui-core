export const BACKUP_QUEUE = 'backup';

export const VELERO_NAMESPACE = 'velero';
export const VELERO_DEPLOYMENT_NAME = 'velero';
export const VELERO_NODE_AGENT_DAEMONSET = 'node-agent';
export const VELERO_IMAGE = 'velero/velero:v1.14.1';
export const VELERO_AWS_PLUGIN_IMAGE = 'velero/velero-plugin-for-aws:v1.10.1';
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- k8s Secret key name, not a value
export const VELERO_KOPIA_REPO_PASSWORD_KEY = 'kopia-repo-password';
export const VELERO_CREDENTIALS_SECRET_NAME = 'velero-cloud-credentials';

export const RCLONE_IMAGE = 'rclone/rclone:1.68';

export const FLUI_LABELS = {
  managedBy: 'managed-by',
  managedByValue: 'flui-cloud',
  resourceType: 'flui-resource-type',
  scope: 'flui.cloud/scope',
  applicationId: 'flui.cloud/applicationId',
  deployId: 'flui.cloud/deployId',
  clusterId: 'flui.cloud/clusterId',
};

export const BACKUP_JOB_TYPES = {
  RUN_BACKUP: 'run-backup',
  RUN_DB_BACKUP: 'run-db-backup',
  RUN_DB_RESTORE: 'run-db-restore',
  REPLICATE_BACKUP: 'replicate-backup',
  RUN_RESTORE: 'run-restore',
  INSTALL_VELERO: 'install-velero',
  HEALTH_CHECK_DESTINATION: 'health-check-destination',
  PRE_DEPLOY_SNAPSHOT: 'pre-deploy-snapshot',
  ENABLE_ETCD_SNAPSHOTS: 'enable-etcd-snapshots',
  CREATE_PROVIDER_SNAPSHOT: 'create-provider-snapshot',
  RUN_PLATFORM_BACKUP: 'run-platform-backup',
} as const;

export const PRE_DEPLOY_SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;
export const VELERO_BACKUP_POLL_INTERVAL_MS = 5_000;
export const VELERO_BACKUP_POLL_TIMEOUT_MS = 30 * 60 * 1000;
export const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
