export interface BackupDestination {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix?: string;
  encryptionMode?: string;
  forcePathStyle?: boolean;
  useSse?: boolean;
  usableForEtcdL1?: boolean;
  costPerGbMonthCents?: number | null;
  health?: string;
  usageBytes?: number;
  metadata?: { costSource?: string } & Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateBackupDestinationInput {
  name: string;
  provider:
    | 'hetzner_object_storage'
    | 'scaleway_object_storage'
    | 'ovh_object_storage'
    | 'minio'
    | 'generic_s3';
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix?: string;
  accessKey: string;
  secretKey: string;
  encryptionMode?: 'flui_managed' | 'byo_passphrase' | 'none';
  encryptionPassphrase?: string;
  forcePathStyle?: boolean;
  useSse?: boolean;
  usableForEtcdL1?: boolean;
  costPerGbMonthCents?: number;
}

export interface BackupPolicy {
  id: string;
  name: string;
  clusterId: string;
  scope: string;
  profile: string;
  engineClass?: string;
  enabled?: boolean;
  status?: string;
  cronSchedule?: string;
  schedule?: string;
  retentionDays?: number;
  scopeSelector?: {
    applicationIds?: string[];
    namespaces?: string[];
    [key: string]: unknown;
  };
  destinations?: Array<{
    destinationId: string;
    role: string;
    priority?: number;
  }>;
  metadata?: {
    platform?: {
      recipient?: string;
      heartbeat?: { url?: string };
    };
    [key: string]: unknown;
  };
  createdAt?: string;
  updatedAt?: string;
}

/** A backup that exists, whatever engine produced it. */
export interface BackupArtifact {
  id: string;
  backupJobId: string;
  clusterId: string;
  applicationId?: string | null;
  volumeName?: string | null;
  engineClass?: string;
  engineRef?: string | null;
  sizeBytes?: string | null;
  itemCount?: number | null;
  expiresAt?: string | null;
  manifestSummary?: Record<string, any>;
  locations?: Array<{
    id: string;
    destinationId: string;
    role: string;
    state: string;
    objectKeyPrefix: string;
  }>;
  createdAt?: string;
}

export interface CreatePolicyInput {
  name: string;
  clusterId: string;
  scope: string;
  profile?: string;
  engineClass?: 'database' | 'platform' | 'volume_copy';
  /** The API's field is cronSchedule — see CreateBackupPolicyDto. */
  cronSchedule?: string;
  retentionDays?: number;
  retentionMaxCopies?: number;
  enabled?: boolean;
  destinations: Array<{
    destinationId: string;
    role: 'primary' | 'replica';
    priority?: number;
  }>;
  scopeSelector?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface BackupJob {
  id: string;
  policyId: string;
  clusterId?: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  finishedAt?: string;
  bytesTransferred?: number;
  errorMessage?: string;
  metadata?: {
    volumesCopied?: string[];
    /** Per volume, seconds the application was stopped for its copy. */
    stoppedSeconds?: Record<string, number>;
  } & Record<string, unknown>;
}

export interface RestoreJob {
  id: string;
  status: string;
  artifactId: string;
  sourceDestinationId: string;
  targetClusterId: string;
  targetKind: string;
  placement?: 'new' | 'existing';
  strategy?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface QuickSetupOptions {
  currentProvider: string;
  primary: {
    provider: string;
    ready: boolean;
    needsScalewayConnection?: boolean;
    reason?: string;
  };
}

export interface QuickSetupInput {
  profile: 'single';
  cronSchedule?: string | null;
  retentionDays?: number;
  runFirstBackup?: boolean;
}

export interface PlatformBackupLinks {
  jobId: string;
  createdAt: string;
  expiresAt: string;
  files: Array<{
    kind: 'keys' | 'db';
    name: string;
    sizeBytes: number;
    url: string;
  }>;
}

export type BackupHealthState =
  | 'ok'
  | 'running'
  | 'failed'
  | 'missed'
  | 'paused'
  | 'never_run'
  | 'on_demand';

export interface BackupRun {
  jobId: string;
  trigger: 'scheduled' | 'manual' | 'platform_update' | (string & {});
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  encrypted: boolean | null;
  expiresAt: string | null;
  stored: 'present' | 'expired' | 'missing' | 'unknown';
  errorMessage: string | null;
}

export interface BackupPolicyActivity {
  policyId: string;
  policyName: string;
  engineClass: string;
  status: string;
  schedule: {
    cron: string | null;
    description: string;
    timezone: 'UTC';
    nextRunAt: string | null;
    previousDueAt: string | null;
  };
  health: {
    state: BackupHealthState;
    detail: string;
    lastSuccessAt: string | null;
  };
  lastRun: BackupRun | null;
  runs: BackupRun[];
  targets?: {
    cluster: { id: string; name: string | null; gone: boolean } | null;
    applications: Array<{
      id: string;
      name: string | null;
      slug: string | null;
      path: string | null;
      gone: boolean;
      goneWith?: 'cluster';
    }>;
  };
}

/** What the last pass decided for one application of a protected cluster. */
export interface ProtectedApp {
  applicationId: string;
  name: string | null;
  outcome:
    | 'protected'
    | 'already_protected'
    | 'waiting'
    | 'needs_decision'
    | 'failed'
    | 'skipped';
  reason?: string;
  engine?: string;
  policyId?: string;
}

/** A volume, or an application, no backup can take consistently until somebody decides. */
export interface NeedsDecisionItem {
  clusterId: string;
  applicationId: string;
  name: string;
  slug: string;
  volume?: string;
  engine?: string;
  reason: string;
  source: 'engine' | 'last_run';
  policyId?: string;
  at?: string;
  options: Array<'stop_during_copy' | 'leave_out'>;
}

export interface ClusterProtection {
  clusterId: string;
  protected: boolean;
  destinationId: string | null;
  replicaDestinationId: string | null;
  cronSchedule: string | null;
  retentionDays: number | null;
  beforeDeploy: boolean;
  since: string | null;
  lastReconciledAt: string | null;
  applications: ProtectedApp[];
  needsDecision: NeedsDecisionItem[];
}

export interface ProtectClusterInput {
  destinationId: string;
  replicaDestinationId?: string;
  cronSchedule?: string;
  retentionDays?: number;
  beforeDeploy?: boolean;
  runFirstBackup?: boolean;
}

export interface BeforeDeployOption {
  applicationId: string;
  enabled: boolean;
  required: boolean;
  takes: { restorePoint: boolean; dump: boolean; volumes: boolean };
  warning?: string;
}

/** A person's decision that an application is not backed up. */
export interface BackupDecision {
  notBackedUp: true;
  note?: string;
  decidedBy: string;
  decidedByName?: string;
  decidedAt: string;
}

export interface BackupDecisionView {
  applicationId: string;
  decision: BackupDecision | null;
}

/** What the retired Velero engine left on a cluster. */
export interface VeleroFootprint {
  clusterId: string;
  clusterName: string;
  reachable: boolean;
  installed: boolean;
  installedByFlui: boolean;
  namespace: 'present' | 'terminating' | 'absent' | 'unknown';
  components: Array<{
    kind: string;
    name: string;
    namespace?: string;
    present: boolean;
  }>;
  definitions: string[];
  objects: number;
  objectsElsewhere: number;
  pausedPolicies: Array<{ id: string; name: string }>;
  leftInDestinations: Array<{
    destinationId: string;
    destinationName: string | null;
    bucket: string | null;
    prefix: string;
    backups: number;
    volumeData?: Array<{ prefix: string; bytes: number }>;
  }>;
  inFlightOperationId: string | null;
}
