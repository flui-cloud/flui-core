import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';

import { BackupJobStatus } from '../enums/backup-job.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import { DestinationHealthStatus } from '../enums/destination-health.enum';

export type StatusSeverity = 'ok' | 'info' | 'warning' | 'critical';

export interface StatusAlert {
  severity: StatusSeverity;
  code: string;
  message: string;
  resourceType?: string;
  resourceId?: string;
  ctaLabel?: string;
  ctaPath?: string;
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
  };
  lastSuccessfulBackupAt?: string;
  alerts: StatusAlert[];
  cta?: { label: string; path: string };
  generatedAt: string;
}

const GONE_CLUSTER_STATUSES = [ClusterStatus.DELETED, ClusterStatus.LOST];

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
    const orphanPolicies = userPolicies.filter(
      (p) => isActive(p) && !liveClusterIds.has(p.clusterId),
    ).length;
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
    const failedJobsLast24h = recentJobs.filter(
      (j) =>
        j.status === BackupJobStatus.FAILED ||
        j.status === BackupJobStatus.CANCELLED,
    ).length;

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

    const alerts = this.buildAlerts({
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
      },
      lastSuccessfulBackupAt: lastSuccessfulBackupAt?.toISOString(),
      alerts,
      cta,
      generatedAt: now.toISOString(),
    };
  }

  private buildAlerts(input: {
    clustersTotal: number;
    clustersWithBackups: number;
    clustersWithoutBackups: number;
    degradedPolicies: number;
    orphanPolicies: number;
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
    if (input.orphanPolicies > 0) {
      alerts.push({
        severity: 'warning',
        code: 'ORPHAN_POLICIES',
        message: `${input.orphanPolicies} backup ${input.orphanPolicies === 1 ? 'policy points' : 'policies point'} at a cluster that no longer exists. They protect nothing; their backups stay restorable.`,
        ctaLabel: 'Open policies',
        ctaPath: '/management/backup/policies',
      });
    }
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
    if (input.failedJobsLast24h > 0) {
      alerts.push({
        severity: 'critical',
        code: 'FAILED_JOBS_24H',
        message: `${input.failedJobsLast24h} backup run(s) failed in the last 24h.`,
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
