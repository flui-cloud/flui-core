import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupJobStatus } from '../enums/backup-job.enum';
import {
  AppCoverage,
  AppCoverageReason,
  AppCoverageState,
  DataReason,
  classifyApp,
  protectPath,
} from '../utils/app-coverage.rules';

export interface AppCoverageRow {
  applicationId: string;
  name: string;
  slug: string;
  kind: string;
  category: string;
  clusterId: string;
  clusterName: string | null;
  holdsData: boolean;
  dataReasons: DataReason[];
  coverage: AppCoverageState;
  reason: AppCoverageReason;
  alarm: boolean;
  policy: {
    id: string;
    name: string;
    scope: string;
    engineClass: string;
    schedule: string | null;
    retentionDays: number | null;
    nextRunAt: string | null;
  } | null;
  coveringPolicies: number;
  lastSuccessAt: string | null;
  protectedUntil: string | null;
  /** The policy form filled in for this app, while it holds data nothing protects. */
  protectPath: string | null;
}

export interface FleetCoverage {
  generatedAt: string;
  summary: {
    applications: number;
    holdingData: number;
    protected: number;
    pending: number;
    toVerify: number;
    unprotected: number;
    alarms: number;
  };
  applications: AppCoverageRow[];
}

const GONE_CLUSTERS = [ClusterStatus.DELETED, ClusterStatus.LOST];
const RECENT_RUNS_READ = 500;

interface FinishedRun {
  applicationId: string | null;
  at: Date;
  /** Volumes the run named as not copied: awaiting a decision, or failed. */
  leftOut: string[];
}

/**
 * Whether a run meant for this app left some of its volumes out. A policy
 * names one application, so a run that names none is that application's.
 */
function skippedApp(
  run: FinishedRun,
  app: Pick<ApplicationEntity, 'id'>,
): boolean {
  return (
    (run.applicationId === null || run.applicationId === app.id) &&
    run.leftOut.length > 0
  );
}

function volumeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) =>
      typeof v === 'string' ? v : (v as { volume?: unknown } | null)?.volume,
    )
    .filter((v): v is string => typeof v === 'string');
}

/**
 * Whether the newest run that was meant to include this app left its volumes
 * out — a known gap, not a policy still waiting for its first run.
 */
function newestRunLeftOut(
  runs: FinishedRun[] | undefined,
  app: Pick<ApplicationEntity, 'id'>,
): boolean {
  const newest = (runs ?? []).find(
    (r) => r.applicationId === null || r.applicationId === app.id,
  );
  return !!newest && skippedApp(newest, app);
}

/** The newest run of a policy that actually captured this app. */
function lastCapture(
  runs: FinishedRun[] | undefined,
  app: Pick<ApplicationEntity, 'id'>,
): Date | null {
  const run = (runs ?? []).find(
    (r) =>
      (r.applicationId === null || r.applicationId === app.id) &&
      !skippedApp(r, app),
  );
  return run?.at ?? null;
}
const GONE_APPS = [ApplicationStatus.DELETING, ApplicationStatus.DELETED];

/**
 * Which applications a backup would bring back, across the whole fleet: every
 * policy scope counted, not only the ones naming an application by id.
 */
@Injectable()
export class AppCoverageService {
  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policies: Repository<BackupPolicyEntity>,
    @InjectRepository(BackupJobEntity)
    private readonly jobs: Repository<BackupJobEntity>,
  ) {}

  /** Applications on clusters that still exist; the caller filters them to what it may read. */
  async candidates(clusterId?: string): Promise<ApplicationEntity[]> {
    const live = await this.clusters.find({
      where: { status: Not(In(GONE_CLUSTERS)) },
      select: { id: true },
    });
    const liveIds = live.map((c) => c.id);
    if (clusterId && !liveIds.includes(clusterId)) return [];
    const scope = clusterId ? [clusterId] : liveIds;
    if (scope.length === 0) return [];
    return this.apps.find({
      where: {
        clusterId: In(scope),
        deletedAt: IsNull(),
        status: Not(In(GONE_APPS)),
      },
      order: { createdAt: 'DESC' },
    });
  }

  async forApplications(
    apps: ApplicationEntity[],
    now = new Date(),
  ): Promise<FleetCoverage> {
    const clusterIds = [...new Set(apps.map((a) => a.clusterId))];
    const [clusters, policies] = clusterIds.length
      ? await Promise.all([
          this.clusters.find({
            where: { id: In(clusterIds) },
            select: { id: true, name: true },
          }),
          this.policies.find({ where: { clusterId: In(clusterIds) } }),
        ])
      : [[], []];
    const clusterName = new Map(clusters.map((c) => [c.id, c.name]));
    const lastSuccess = await this.lastSuccesses(policies.map((p) => p.id));

    const rows = apps.map((app) =>
      this.toRow(
        app,
        clusterName.get(app.clusterId) ?? null,
        classifyApp(
          {
            id: app.id,
            clusterId: app.clusterId,
            namespace: app.k8sNamespace,
            kind: app.kind,
            category: app.category,
            volumes: app.volumes,
            workloadKind: app.workloadKind,
          },
          policies,
          (policyId) => lastCapture(lastSuccess.get(policyId), app),
          now,
          (policyId) => newestRunLeftOut(lastSuccess.get(policyId), app),
        ),
      ),
    );
    rows.sort(byAttention);

    const count = (state: AppCoverageState) =>
      rows.filter((r) => r.coverage === state).length;
    return {
      generatedAt: now.toISOString(),
      summary: {
        applications: rows.length,
        holdingData: rows.filter((r) => r.holdsData).length,
        protected: count('protected'),
        pending: count('pending'),
        toVerify: count('to_verify'),
        unprotected: count('unprotected'),
        alarms: rows.filter((r) => r.alarm).length,
      },
      applications: rows,
    };
  }

  async forApplicationId(id: string): Promise<AppCoverageRow | null> {
    const app = await this.apps.findOne({ where: { id, deletedAt: IsNull() } });
    if (!app) return null;
    const { applications } = await this.forApplications([app]);
    return applications[0] ?? null;
  }

  /**
   * The recent finished runs of each policy, newest first, with the volumes
   * each one had to leave out. A run that left out some volumes still
   * protected the apps it did capture.
   */
  private async lastSuccesses(
    policyIds: string[],
  ): Promise<Map<string, FinishedRun[]>> {
    const out = new Map<string, FinishedRun[]>();
    if (policyIds.length === 0) return out;
    const rows: Array<{
      policyId: string;
      applicationId: string | null;
      at: Date | string;
      needsDecision: unknown;
      failed: unknown;
    }> = await this.jobs
      .createQueryBuilder('j')
      .select('j."policyId"', 'policyId')
      .addSelect('j."applicationId"', 'applicationId')
      .addSelect('COALESCE(j."finishedAt", j."createdAt")', 'at')
      .addSelect(`j."metadata"->'volumesNeedingDecision'`, 'needsDecision')
      .addSelect(`j."metadata"->'volumesFailed'`, 'failed')
      .where('j."policyId" IN (:...policyIds)', { policyIds })
      .andWhere('j.status IN (:...statuses)', {
        statuses: [
          BackupJobStatus.COMPLETED,
          BackupJobStatus.PARTIALLY_COMPLETED,
        ],
      })
      .orderBy('at', 'DESC')
      .limit(RECENT_RUNS_READ)
      .getRawMany();
    for (const row of rows) {
      const runs = out.get(row.policyId) ?? [];
      runs.push({
        applicationId: row.applicationId,
        at: new Date(row.at),
        leftOut: [
          ...volumeNames(row.needsDecision),
          ...volumeNames(row.failed),
        ],
      });
      out.set(row.policyId, runs);
    }
    return out;
  }

  private toRow(
    app: ApplicationEntity,
    clusterName: string | null,
    c: AppCoverage,
  ): AppCoverageRow {
    return {
      applicationId: app.id,
      name: app.name,
      slug: app.slug,
      kind: app.kind,
      category: app.category,
      clusterId: app.clusterId,
      clusterName,
      holdsData: c.holdsData,
      dataReasons: c.dataReasons,
      coverage: c.state,
      reason: c.reason,
      alarm: c.alarm,
      policy: c.policy
        ? {
            id: c.policy.id,
            name: c.policy.name,
            scope: c.policy.scope,
            engineClass: c.policy.engineClass,
            schedule: c.policy.cronSchedule ?? null,
            retentionDays: c.policy.retentionDays ?? null,
            nextRunAt:
              c.policy.enabled && c.policy.nextRunAt
                ? new Date(c.policy.nextRunAt).toISOString()
                : null,
          }
        : null,
      coveringPolicies: c.coveringPolicies,
      lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
      protectedUntil:
        c.state === 'protected' ? (c.deadline?.toISOString() ?? null) : null,
      protectPath:
        c.holdsData && c.state === 'unprotected'
          ? protectPath({
              clusterId: app.clusterId,
              applicationId: app.id,
              kind: app.kind,
            })
          : null,
    };
  }
}

/** Alarms first and databases first among them, then whatever else holds data. */
function byAttention(a: AppCoverageRow, b: AppCoverageRow): number {
  const weight = (r: AppCoverageRow) =>
    (r.alarm ? 0 : 4) +
    (r.kind === ApplicationKind.DATABASE ? 0 : 1) +
    (r.holdsData ? 0 : 2);
  return weight(a) - weight(b) || a.name.localeCompare(b.name);
}
