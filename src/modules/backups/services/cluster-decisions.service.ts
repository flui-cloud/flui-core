import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { hookForEngine } from '../../applications/services/volume-copy-hooks';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';
import {
  EngineSupport,
  ExistingCover,
  planAppProtection,
} from '../utils/cluster-protection.plan';

export type DecisionOption = 'stop_during_copy' | 'leave_out';

/** One volume, or one application, that no backup can take consistently until somebody decides. */
export interface NeedsDecisionItem {
  clusterId: string;
  applicationId: string;
  name: string;
  slug: string;
  /** Set when a run refused one volume; absent when the whole application is in question. */
  volume?: string;
  engine?: string;
  reason: string;
  /** `engine`: judged from what the application declares. `last_run`: a copy refused it. */
  source: 'engine' | 'last_run';
  policyId?: string;
  at?: string;
  options: DecisionOption[];
}

const GONE_APPS = [ApplicationStatus.DELETING, ApplicationStatus.DELETED];
const FINISHED = [
  BackupJobStatus.COMPLETED,
  BackupJobStatus.PARTIALLY_COMPLETED,
  BackupJobStatus.FAILED,
];
const RUNS_READ = 500;

export function coverOf(
  appId: string,
  policies: ReadonlyArray<
    Pick<BackupPolicyEntity, 'engineClass' | 'scopeSelector'>
  >,
): ExistingCover {
  const names = (p: Pick<BackupPolicyEntity, 'scopeSelector'>) =>
    (p.scopeSelector?.applicationIds ?? []).includes(appId);
  return {
    database: policies.some(
      (p) => p.engineClass === BackupEngineClass.DATABASE && names(p),
    ),
    volumeCopy: policies.some(
      (p) => p.engineClass === BackupEngineClass.VOLUME_COPY && names(p),
    ),
  };
}

/**
 * Volumes nightly backups cannot take consistently, per cluster: databases Flui
 * does not recognise, and volumes the last copy had to refuse. Each is a
 * question for a person (stop the application during the copy, or leave the
 * volume out), so it is surfaced where the cluster's protection is read rather
 * than as a failure that repeats every night.
 */
@Injectable()
export class ClusterDecisionsService {
  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policies: Repository<BackupPolicyEntity>,
    @InjectRepository(BackupJobEntity)
    private readonly jobs: Repository<BackupJobEntity>,
    private readonly engines: ContinuousBackupEngineRegistry,
  ) {}

  support(): EngineSupport {
    return {
      database: (engine) => this.engines.supports(engine),
      consistentCopy: (engine) => !!hookForEngine(engine),
    };
  }

  async forClusters(
    clusterIds: string[],
  ): Promise<Map<string, NeedsDecisionItem[]>> {
    const out = new Map<string, NeedsDecisionItem[]>();
    if (clusterIds.length === 0) return out;
    const [apps, policies] = await Promise.all([
      this.apps.find({
        where: {
          clusterId: In(clusterIds),
          deletedAt: IsNull(),
          status: Not(In(GONE_APPS)),
        },
      }),
      this.policies.find({ where: { clusterId: In(clusterIds) } }),
    ]);
    const lastRuns = await this.lastVolumeCopyRuns(
      policies.filter(
        (p) => p.engineClass === BackupEngineClass.VOLUME_COPY && p.enabled,
      ),
    );
    const items = needsDecision(apps, policies, lastRuns, this.support());
    for (const item of items) {
      const list = out.get(item.clusterId) ?? [];
      list.push(item);
      out.set(item.clusterId, list);
    }
    return out;
  }

  async forCluster(clusterId: string): Promise<NeedsDecisionItem[]> {
    return (await this.forClusters([clusterId])).get(clusterId) ?? [];
  }

  private async lastVolumeCopyRuns(
    policies: BackupPolicyEntity[],
  ): Promise<Map<string, BackupJobEntity>> {
    const out = new Map<string, BackupJobEntity>();
    if (policies.length === 0) return out;
    const rows = await this.jobs.find({
      where: {
        policyId: In(policies.map((p) => p.id)),
        status: In(FINISHED),
      },
      order: { createdAt: 'DESC' },
      take: RUNS_READ,
    });
    for (const row of rows) {
      if (row.policyId && !out.has(row.policyId)) out.set(row.policyId, row);
    }
    return out;
  }
}

type DecisionApp = Pick<
  ApplicationEntity,
  | 'id'
  | 'name'
  | 'slug'
  | 'clusterId'
  | 'kind'
  | 'category'
  | 'systemProtected'
  | 'volumes'
  | 'labels'
>;

type LastRun = Pick<BackupJobEntity, 'metadata' | 'finishedAt' | 'createdAt'>;

export function needsDecision(
  apps: ReadonlyArray<DecisionApp>,
  policies: ReadonlyArray<BackupPolicyEntity>,
  lastRuns: ReadonlyMap<string, LastRun>,
  support: EngineSupport,
): NeedsDecisionItem[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  return [
    ...apps.flatMap((app) => engineDecision(app, policies, support)),
    ...policies.flatMap((policy) => lastRunDecisions(policy, byId, lastRuns)),
  ];
}

function engineDecision(
  app: DecisionApp,
  policies: ReadonlyArray<BackupPolicyEntity>,
  support: EngineSupport,
): NeedsDecisionItem[] {
  const plan = planAppProtection(app, coverOf(app.id, policies), support);
  if (plan.kind !== 'needs_decision') return [];
  return [
    {
      clusterId: app.clusterId,
      applicationId: app.id,
      name: app.name,
      slug: app.slug,
      engine: plan.engine,
      reason: plan.reason,
      source: 'engine',
      options: ['stop_during_copy', 'leave_out'],
    },
  ];
}

function lastRunDecisions(
  policy: BackupPolicyEntity,
  byId: ReadonlyMap<string, DecisionApp>,
  lastRuns: ReadonlyMap<string, LastRun>,
): NeedsDecisionItem[] {
  if (policy.engineClass !== BackupEngineClass.VOLUME_COPY) return [];
  if (!policy.enabled || policy.metadata?.pauseDuringCopy === true) return [];
  const app = byId.get(policy.scopeSelector?.applicationIds?.[0] ?? '');
  const run = lastRuns.get(policy.id);
  if (!app || !run) return [];
  const excluded = new Set<string>(policy.metadata?.excludeVolumes ?? []);
  const refused: Array<{ volume?: string; reason?: string }> = Array.isArray(
    run.metadata?.volumesNeedingDecision,
  )
    ? run.metadata.volumesNeedingDecision
    : [];
  const items: NeedsDecisionItem[] = [];
  for (const v of refused) {
    if (!v?.volume || excluded.has(v.volume)) continue;
    items.push({
      clusterId: app.clusterId,
      applicationId: app.id,
      name: app.name,
      slug: app.slug,
      volume: v.volume,
      reason: v.reason ?? 'the last copy could not take it consistently',
      source: 'last_run',
      policyId: policy.id,
      at: (run.finishedAt ?? run.createdAt)?.toISOString(),
      options: ['stop_during_copy', 'leave_out'],
    });
  }
  return items;
}
