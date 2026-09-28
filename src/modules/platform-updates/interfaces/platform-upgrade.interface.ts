import {
  K3sClusterUpgradeState,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';

export const WITHOUT_BACKUP_ACKNOWLEDGEMENT =
  'Without a backup, a database migration cannot be undone.';

export type UpgradePhaseKey =
  | 'backup'
  | 'manifests'
  | 'images'
  | 'k3s'
  | 'verify';

export type UpgradePhaseStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'skipped'
  | 'failed';

export interface UpgradePlanBlocker {
  phase: UpgradePhaseKey | 'release';
  message: string;
  /** True for the one blocker a written acknowledgement may pass: no backup. */
  overridable?: boolean;
}

export interface UpgradePlanFile {
  name: string;
  action: 'replace' | 'add';
  releaseSha?: string;
}

export interface UpgradePlanCluster {
  clusterId: string;
  clusterName: string;
  clusterType: 'control' | 'workload';
  /** Manifests: the refresh plan id this cluster is applied with. */
  planId?: string;
  ref?: string;
  files?: UpgradePlanFile[];
  leftAlone?: number;
  /** K3s: minor versions passed through, in order. */
  steps?: string[];
  fromVersion?: string | null;
  nodes?: Array<{
    name: string;
    role: 'server' | 'agent';
    kubeletVersion: string | null;
    ready: boolean;
  }>;
  upToDate: boolean;
  blockers: string[];
}

export interface UpgradePlanComponent {
  key: string;
  name: string;
  fromVersion: string | null;
  targetVersion: string | null;
  imageRef: string;
  changed: boolean;
}

export interface UpgradePlanPhase {
  key: UpgradePhaseKey;
  title: string;
  willRun: boolean;
  summary: string;
  blockers: UpgradePlanBlocker[];
  backup?: { policyId: string | null; policyName: string | null };
  clusters?: UpgradePlanCluster[];
  components?: UpgradePlanComponent[];
}

export interface UpgradePlanAdvisory {
  level: 'info' | 'warning' | 'blocker';
  title: string;
  detail: string;
}

export interface PlatformUpgradePlan {
  planId: string;
  fromVersion: string;
  targetVersion: string;
  bootstrapRef: string;
  k3sVersion: string | null;
  migrations: number;
  phases: UpgradePlanPhase[];
  advisories: UpgradePlanAdvisory[];
  blockers: UpgradePlanBlocker[];
  /** True when nothing but an acknowledged missing backup stands in the way. */
  applicable: boolean;
  acknowledgement: string;
}

export interface UpgradePhaseCluster {
  clusterId: string;
  clusterName: string;
  clusterType: 'control' | 'workload';
  status: UpgradePhaseStatus;
  planId?: string;
  approved?: UpgradePlanFile[];
  wrote?: string[];
  backupPath?: string;
  /** K3s: how many minor steps and nodes the plan counted, for the deadline. */
  stepCount?: number;
  nodeCount?: number;
  error?: string;
}

export interface UpgradePhaseState {
  key: UpgradePhaseKey;
  title: string;
  status: UpgradePhaseStatus;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  clusters?: UpgradePhaseCluster[];
  policyId?: string | null;
  backupJobId?: string;
  checks?: Array<{ name: string; ok: boolean; detail?: string }>;
  message?: string;
  error?: string;
}

export interface PlatformUpgradeMetadata
  extends PlatformUpdateOperationMetadata {
  schema: 2;
  planId: string;
  bootstrapRef: string;
  k3sVersion: string | null;
  withoutBackup: boolean;
  acknowledgement?: string;
  phases: UpgradePhaseState[];
  failedPhase?: UpgradePhaseKey;
  guidance?: string;
  k3sUpgrades?: Record<string, K3sClusterUpgradeState>;
}

export function isUpgradeMetadata(
  metadata: unknown,
): metadata is PlatformUpgradeMetadata {
  return (
    !!metadata &&
    (metadata as { schema?: unknown }).schema === 2 &&
    Array.isArray((metadata as { phases?: unknown }).phases)
  );
}
