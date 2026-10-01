import { Injectable, Logger, Optional } from '@nestjs/common';
import { GONE_CLUSTER_STATUSES } from '../utils/policy-cluster.util';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';

import { BackupJobStatus } from '../enums/backup-job.enum';
import { unresolvedFailures } from '../utils/unresolved-failures.util';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import { DestinationHealthStatus } from '../enums/destination-health.enum';
import { BackupClusterProtectionEntity } from '../entities/backup-cluster-protection.entity';
import {
  StatusAlertItem,
  orphanPoliciesAlert,
} from '../utils/orphan-policies.alert';
import { isRetiredEngineClass } from '../enums/backup-engine-class.enum';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  ClusterDecisionsService,
  NeedsDecisionItem,
} from './cluster-decisions.service';

export type StatusSeverity = 'ok' | 'info' | 'warning' | 'critical';

export interface StatusAlert {
  severity: StatusSeverity;
  code: string;
  message: string;
  resourceType?: string;
  resourceId?: string;
  ctaLabel?: string;
  ctaPath?: string;
  /** The resources the alert is about, when it names them, each with its page. */
  items?: StatusAlertItem[];
}

/** One live cluster, as far as backups are concerned. */
export interface ClusterBackupState {
  clusterId: string;
  name: string;
  /** Every application gets a policy, including the ones installed later. */
  protected: boolean;
  /** Volumes no backup can take consistently until a person decides. */
  needsDecision: NeedsDecisionItem[];
  /** Applications the last pass could not protect yet: waiting to run, or failed and retried. */
  pending: number;
}

export interface BackupStatusResponse {
  overall: StatusSeverity;
  summary: {
    clustersTotal: number;
    clustersWithBackups: number;
    clustersWithoutBackups: number;
    activePolicies: number;
    degradedPolicies: number;
    failedDestinations: number;
    healthyDestinations: number;
    totalArtifactsLast30d: number;
    failedJobsLast24h: number;
    needsDecision: number;
  };
  clusters: ClusterBackupState[];
  lastSuccessfulBackupAt?: string;
  alerts: StatusAlert[];
  cta?: { label: string; path: string };
  generatedAt: string;
}

@Injectable()
export class BackupStatusService {
  private readonly logger = new Logger(BackupStatusService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRepo: Repository<BackupPolicyEntity>,
    @InjectRepository(BackupDestinationEntity)
    private readonly destRepo: Repository<BackupDestinationEntity>,
    @InjectRepository(BackupJobEntity)
    private readonly jobRepo: Repository<BackupJobEntity>,
    @InjectRepository(BackupArtifactEntity)
    private readonly artifactRepo: Repository<BackupArtifactEntity>,
    @InjectRepository(BackupArtifactLocationEntity)
    private readonly locationRepo: Repository<BackupArtifactLocationEntity>,
    @Optional()
    @InjectRepository(BackupClusterProtectionEntity)
    private readonly protectionRepo?: Repository<BackupClusterProtectionEntity>,
    @Optional() private readonly decisions?: ClusterDecisionsService,
    @Optional()
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo?: Repository<InfrastructureOperationEntity>,
  ) {}

  async getStatus(userId: string): Promise<BackupStatusResponse> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Only clusters that still exist: a deleted or lost cluster is neither
    // protected nor unprotected.
    const clusters = await this.clusterRepo.find({
      where: { status: Not(In(GONE_CLUSTER_STATUSES)) },
    });
    const liveClusterIds = new Set(clusters.map((c) => c.id));
    const userPolicies = await this.policyRepo.find({ where: { userId } });
    const userDestinations = await this.destRepo.find({ where: { userId } });

    const isActive = (p: BackupPolicyEntity) =>
      p.enabled && p.status === BackupPolicyStatus.ACTIVE;
    const clustersWithPolicy = new Set(
      userPolicies
        .filter((p) => isActive(p) && liveClusterIds.has(p.clusterId))
        .map((p) => p.clusterId),
    );
    // A policy already paused for its gone cluster needs nothing from anyone;
    // only one still trying to run is worth a word.
    const orphanPolicies = userPolicies.filter(
      (p) => !liveClusterIds.has(p.clusterId) && isActive(p),
    );
    const clustersTotal = clusters.length;
    const clustersWithBackups = clustersWithPolicy.size;
    const clustersWithoutBackups = Math.max(
      0,
      clustersTotal - clustersWithBackups,
    );

    const activePolicies = userPolicies.filter(
      (p) => isActive(p) && liveClusterIds.has(p.clusterId),
    ).length;
    const degradedPolicies = userPolicies.filter(
      (p) => p.status === BackupPolicyStatus.DEGRADED,
    ).length;

    const failed = userDestinations.filter(
      (d) => d.healthStatus === DestinationHealthStatus.FAILED,
    );
    const failedDestinations = failed.length;
    const healthyDestinations = userDestinations.filter(
      (d) => d.healthStatus === DestinationHealthStatus.HEALTHY,
    ).length;

    const recentJobs = await this.jobRepo
      .createQueryBuilder('j')
      .where('j.userId = :userId', { userId })
      .andWhere('j.createdAt >= :since', { since: last24h })
      .getMany();
    const failedJobsLast24h = unresolvedFailures(recentJobs);

    const allUserClusterIds = clusters
      .filter((c) => clustersWithPolicy.has(c.id))
      .map((c) => c.id);
    let totalArtifactsLast30d = 0;
    let lastSuccessfulBackupAt: Date | undefined;
    if (allUserClusterIds.length > 0) {
      const artifacts = await this.artifactRepo.find({
        where: { clusterId: In(allUserClusterIds) },
        order: { createdAt: 'DESC' },
      });
      totalArtifactsLast30d = artifacts.filter(
        (a) => a.createdAt >= last30d,
      ).length;
      if (artifacts.length > 0) {
        lastSuccessfulBackupAt = artifacts[0].createdAt;
      }
    }
    // A database whose base is not yet due completes its run without a new
    // artifact: its logs are the backup, and the run checked they are shipping.
    for (const job of recentJobs) {
      if (job.status !== BackupJobStatus.COMPLETED || !job.finishedAt) continue;
      if (!lastSuccessfulBackupAt || job.finishedAt > lastSuccessfulBackupAt) {
        lastSuccessfulBackupAt = job.finishedAt;
      }
    }

    const clusterStates = await this.clusterStates(clusters);
    const needsDecision = clusterStates.reduce(
      (n, c) => n + c.needsDecision.length,
      0,
    );

    const retiredEngineClusters = await this.clustersStillCarryingRetiredEngine(
      clusters.filter((c) =>
        userPolicies.some(
          (p) => p.clusterId === c.id && isRetiredEngineClass(p.engineClass),
        ),
      ),
    );

    const alerts = this.buildAlerts({
      needsDecision,
      retiredEngineClusters,
      clustersTotal,
      clustersWithBackups,
      clustersWithoutBackups,
      degradedPolicies,
      orphanPolicies,
      failedDestinations,
      failedDestinationReason: failed.find((d) => d.lastHealthError)
        ?.lastHealthError,
      failedJobsLast24h,
      lastSuccessfulBackupAt,
      now,
    });

    const overall: StatusSeverity = this.aggregateSeverity(alerts);
    const cta = this.computeCta({
      clustersTotal,
      clustersWithBackups,
    });

    return {
      overall,
      summary: {
        clustersTotal,
        clustersWithBackups,
        clustersWithoutBackups,
        activePolicies,
        degradedPolicies,
        failedDestinations,
        healthyDestinations,
        totalArtifactsLast30d,
        failedJobsLast24h,
        needsDecision,
      },
      clusters: clusterStates,
      lastSuccessfulBackupAt: lastSuccessfulBackupAt?.toISOString(),
      alerts,
      cta,
      generatedAt: now.toISOString(),
    };
  }

  private async clusterStates(
    clusters: ClusterEntity[],
  ): Promise<ClusterBackupState[]> {
    if (clusters.length === 0) return [];
    const ids = clusters.map((c) => c.id);
    const [protectedRows, decisions] = await Promise.all([
      this.protectionRepo?.find({ where: { clusterId: In(ids) } }) ??
        ([] as BackupClusterProtectionEntity[]),
      this.decisions?.forClusters(ids) ??
        new Map<string, NeedsDecisionItem[]>(),
    ]);
    const byCluster = new Map(protectedRows.map((r) => [r.clusterId, r]));
    return clusters.map((c) => ({
      clusterId: c.id,
      name: c.name,
      protected: byCluster.has(c.id),
      needsDecision: decisions.get(c.id) ?? [],
      pending: Object.values(byCluster.get(c.id)?.applications ?? {}).filter(
        (a) => a.outcome === 'waiting' || a.outcome === 'failed',
      ).length,
    }));
  }

  /**
   * Clusters whose policies ran the removed cluster-backup engine and that
   * have not had it taken off since. Read from Flui's own records: asking
   * every cluster on each status read would cost a round trip per cluster.
   */
  private async clustersStillCarryingRetiredEngine(
    candidates: ClusterEntity[],
  ): Promise<ClusterEntity[]> {
    if (candidates.length === 0 || !this.opRepo) return [];
    const done = await this.opRepo.find({
      where: {
        operationType: OperationType.UNINSTALL_VELERO,
        status: OperationStatus.COMPLETED,
        resourceId: In(candidates.map((c) => c.id)),
      },
      select: { resourceId: true },
    });
    const removed = new Set(done.map((o) => o.resourceId));
    return candidates.filter((c) => !removed.has(c.id));
  }

  private buildAlerts(input: {
    needsDecision: number;
    retiredEngineClusters?: ClusterEntity[];
    clustersTotal: number;
    clustersWithBackups: number;
    clustersWithoutBackups: number;
    degradedPolicies: number;
    orphanPolicies: Array<{ id: string; name: string }>;
    failedDestinations: number;
    failedDestinationReason?: string;
    failedJobsLast24h: number;
    lastSuccessfulBackupAt?: Date;
    now: Date;
  }): StatusAlert[] {
    const alerts: StatusAlert[] = [];
    if (input.clustersTotal === 0) {
      alerts.push({
        severity: 'info',
        code: 'NO_CLUSTERS',
        message:
          'Create your first cluster to start using Flui. Backups can be turned on with one click afterwards.',
        ctaLabel: 'Create cluster',
        ctaPath: '/cluster',
      });
      return alerts;
    }
    if (input.clustersWithoutBackups > 0) {
      alerts.push({
        severity: 'warning',
        code: 'CLUSTERS_WITHOUT_BACKUPS',
        message: `${input.clustersWithoutBackups} of ${input.clustersTotal} clusters have no backups.`,
        ctaLabel: 'Enable backups',
        ctaPath: '/management/backup/overview',
      });
    }
    if (input.degradedPolicies > 0) {
      alerts.push({
        severity: 'warning',
        code: 'DEGRADED_POLICIES',
        message: `${input.degradedPolicies} policy(ies) degraded — cross-provider replication is failing. Check the credentials.`,
        ctaLabel: 'Check destinations',
        ctaPath: '/management/backup/destinations',
      });
    }
    const orphans = orphanPoliciesAlert(input.orphanPolicies);
    if (orphans) alerts.push(orphans);
    if (input.failedDestinations > 0) {
      const reason = input.failedDestinationReason
        ? ' ' + input.failedDestinationReason
        : '';
      alerts.push({
        severity: 'critical',
        code: 'FAILED_DESTINATIONS',
        message: `${input.failedDestinations} destination(s) unusable. The next backups will fail.${reason}`,
        ctaLabel: 'Open destinations',
        ctaPath: '/management/backup/destinations',
      });
    }
    if (input.needsDecision > 0) {
      alerts.push({
        severity: 'warning',
        code: 'VOLUMES_NEED_DECISION',
        message: `${input.needsDecision} volume(s) cannot be backed up consistently while their application runs. Choose for each: stop the application during the copy, or leave the volume out.`,
        ctaLabel: 'Review',
        ctaPath: '/management/backup/overview',
      });
    }
    for (const cluster of input.retiredEngineClusters ?? []) {
      alerts.push({
        severity: 'info',
        code: 'RETIRED_BACKUP_ENGINE_INSTALLED',
        message: `Cluster ${cluster.name} may still run the cluster backup engine Flui no longer uses. Remove it with \`flui backup velero uninstall ${cluster.name}\`; the backups it wrote stay in their destination.`,
        resourceType: 'cluster',
        resourceId: cluster.id,
      });
    }
    if (input.failedJobsLast24h > 0) {
      alerts.push({
        severity: 'critical',
        code: 'FAILED_JOBS_24H',
        message: `${input.failedJobsLast24h} backup run(s) failed in the last 24h and have not run successfully since.`,
        ctaLabel: 'Open history',
        ctaPath: '/management/backup/jobs',
      });
    }
    if (
      input.clustersWithBackups > 0 &&
      (!input.lastSuccessfulBackupAt ||
        input.now.getTime() - input.lastSuccessfulBackupAt.getTime() >
          36 * 60 * 60 * 1000)
    ) {
      alerts.push({
        severity: 'warning',
        code: 'STALE_BACKUPS',
        message:
          'No backup has completed in 36 hours. The scheduler may be stopped, or the destinations unreachable.',
        ctaLabel: 'Diagnose',
        ctaPath: '/management/backup/jobs',
      });
    }
    if (alerts.length === 0) {
      alerts.push({
        severity: 'ok',
        code: 'ALL_GOOD',
        message: 'All backups are active and healthy.',
      });
    }
    return alerts;
  }

  private aggregateSeverity(alerts: StatusAlert[]): StatusSeverity {
    if (alerts.some((a) => a.severity === 'critical')) return 'critical';
    if (alerts.some((a) => a.severity === 'warning')) return 'warning';
    if (alerts.some((a) => a.severity === 'info')) return 'info';
    return 'ok';
  }

  private computeCta(input: {
    clustersTotal: number;
    clustersWithBackups: number;
  }): { label: string; path: string } | undefined {
    if (input.clustersTotal === 0) {
      return { label: 'Create your first cluster', path: '/cluster' };
    }
    if (input.clustersWithBackups === 0) {
      return { label: 'Enable backups', path: '/management/backup/overview' };
    }
    return undefined;
  }
}
