import { DataSource } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  BackupClusterProtectionEntity,
  ProtectedAppOutcome,
} from '../entities/backup-cluster-protection.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { CreateBackupPolicyDto } from '../dto/create-backup-policy.dto';
import type { NeedsDecisionItem } from '../services/cluster-decisions.service';
import { AppProtectionPlan } from './cluster-protection.plan';

export interface ProtectClusterInput {
  destinationId: string;
  replicaDestinationId?: string | null;
  cronSchedule?: string | null;
  retentionDays?: number;
  beforeDeploy?: boolean;
  runFirstBackup?: boolean;
}

export interface ProtectedAppView extends ProtectedAppOutcome {
  applicationId: string;
  name: string | null;
}

export interface ClusterProtectionView {
  clusterId: string;
  protected: boolean;
  destinationId: string | null;
  replicaDestinationId: string | null;
  cronSchedule: string | null;
  retentionDays: number | null;
  beforeDeploy: boolean;
  since: string | null;
  lastReconciledAt: string | null;
  applications: ProtectedAppView[];
  needsDecision: NeedsDecisionItem[];
}

export interface ReconcileOptions {
  runFirstBackup?: boolean;
  onlyAppIds?: string[];
  /** Wait for a pass already running on this cluster instead of leaving it to that one. */
  waitForLock?: boolean;
  onProgress?: (
    done: number,
    total: number,
    app: ProtectedAppView,
  ) => Promise<void>;
}

export interface ReconcileResult {
  applications: ProtectedAppView[];
}

/** A failed attempt is retried by the sweep after this long, not every pass. */
const FAILED_RETRY_MS = 60 * 60 * 1000;
const NAME_SLUG_MAX = 100;
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function toProtectionView(
  clusterId: string,
  row: BackupClusterProtectionEntity | null,
  needsDecision: NeedsDecisionItem[],
  names: Map<string, string>,
): ClusterProtectionView {
  return {
    clusterId,
    protected: !!row,
    destinationId: row?.destinationId ?? null,
    replicaDestinationId: row?.replicaDestinationId ?? null,
    cronSchedule: row?.cronSchedule ?? null,
    retentionDays: row?.retentionDays ?? null,
    beforeDeploy: row?.beforeDeploy ?? false,
    since: row?.createdAt?.toISOString() ?? null,
    lastReconciledAt: row?.lastReconciledAt?.toISOString() ?? null,
    applications: Object.entries(row?.applications ?? {}).map(
      ([applicationId, o]) => ({
        applicationId,
        name: names.get(applicationId) ?? null,
        ...o,
      }),
    ),
    needsDecision,
  };
}

export function isRecentFailure(
  previous: ProtectedAppOutcome | undefined,
  now: number,
): previous is ProtectedAppOutcome {
  return (
    previous?.outcome === 'failed' &&
    now - new Date(previous.at).getTime() < FAILED_RETRY_MS
  );
}

export function outcomesStillOnCluster(
  outcomes: Record<string, ProtectedAppOutcome>,
  apps: Array<{ id: string }>,
): Record<string, ProtectedAppOutcome> {
  return Object.fromEntries(
    Object.entries(outcomes).filter(([id]) => apps.some((a) => a.id === id)),
  );
}

export function outcomeWithoutPolicy(
  plan: AppProtectionPlan,
  at: string,
): ProtectedAppOutcome | null {
  switch (plan.kind) {
    case 'skip':
      return { outcome: 'skipped', reason: plan.reason, at };
    case 'already_protected':
      return { outcome: 'already_protected', at };
    case 'needs_decision':
      return {
        outcome: 'needs_decision',
        reason: plan.reason,
        engine: plan.engine,
        at,
      };
  }
  return null;
}

export function protectionPolicyDto(
  app: ApplicationEntity,
  row: BackupClusterProtectionEntity,
  engineClass: BackupEngineClass,
  withReplica: boolean,
): CreateBackupPolicyDto {
  const slug = app.slug.slice(0, NAME_SLUG_MAX);
  return {
    name:
      engineClass === BackupEngineClass.DATABASE
        ? `${slug}-continuous`
        : `${slug}-volumes`,
    clusterId: app.clusterId,
    scope: BackupScope.APPLICATIONS,
    engineClass,
    scopeSelector: { applicationIds: [app.id] },
    cronSchedule: row.cronSchedule ?? undefined,
    retentionDays: row.retentionDays,
    destinations: [
      {
        destinationId: row.destinationId,
        role: DestinationRole.PRIMARY,
        priority: 0,
      },
      ...(withReplica && row.replicaDestinationId
        ? [
            {
              destinationId: row.replicaDestinationId,
              role: DestinationRole.REPLICA,
              priority: 1,
            },
          ]
        : []),
    ],
  };
}

export async function withClusterLock<T>(
  dataSource: DataSource,
  clusterId: string,
  wait: boolean,
  fn: () => Promise<T>,
): Promise<T | null> {
  const key = `backup-protect:${clusterId}`;
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const deadline = Date.now() + (wait ? LOCK_WAIT_MS : 0);
    for (;;) {
      const [row] = await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [key],
      );
      if (row?.locked) break;
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_POLL_MS);
    }
    try {
      return await fn();
    } finally {
      await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    }
  } finally {
    await runner.release();
  }
}
