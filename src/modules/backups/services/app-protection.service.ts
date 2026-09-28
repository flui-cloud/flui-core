import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { latestCaptureSize } from '../utils/app-coverage.rules';
import { BackupJobRepository } from '../repositories/backup-job.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { DestinationRole } from '../enums/destination-role.enum';
import { AppCoverageRow, AppCoverageService } from './app-coverage.service';

export interface AppProtectionPolicy {
  policyId: string;
  name: string;
  engineClass: string;
  /** The tool behind a database policy; `*-dump` means scheduled dumps. */
  engine: string | null;
  schedule: string | null;
  enabled: boolean;
  status: string;
  destination: { id: string; name: string; provider: string } | null;
  lastRun: {
    status: string;
    at: string | null;
    error: string | null;
  } | null;
  nextRunAt: string | null;
}

export interface AppProtection {
  applicationId: string;
  /** True when at least one enabled policy sends this application off the cluster. */
  protectedOffCluster: boolean;
  policies: AppProtectionPolicy[];
  /** The fleet rule for this application: every policy scope, the data test and recency. */
  coverage: AppCoverageRow | null;
  /**
   * Bytes the newest backup of the covering policy wrote for this application.
   * Null when that backup was not written per application (a whole-cluster
   * backup) or recorded no size.
   */
  lastBackupSizeBytes: number | null;
}

/**
 * What protects one application off the cluster, in one answer: which
 * policies cover it, where they write, and how their last run went. Copies on
 * the cluster are not part of it — they go with the cluster.
 */
const FAILED_RUN = new Set(['failed', 'cancelled']);

@Injectable()
export class AppProtectionService {
  constructor(
    @InjectRepository(BackupPolicyEntity)
    private readonly policies: Repository<BackupPolicyEntity>,
    private readonly jobs: BackupJobRepository,
    private readonly destinations: BackupDestinationRepository,
    private readonly coverage: AppCoverageService,
    @InjectRepository(BackupArtifactEntity)
    private readonly artifacts: Repository<BackupArtifactEntity>,
  ) {}

  async forApplication(applicationId: string): Promise<AppProtection> {
    const covering = await this.policies
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.destinations', 'd')
      .where(`p."scopeSelector"->'applicationIds' @> :ids::jsonb`, {
        ids: JSON.stringify([applicationId]),
      })
      .orderBy('p.createdAt', 'DESC')
      .getMany();

    const result: AppProtectionPolicy[] = [];
    for (const p of covering) {
      const primary =
        p.destinations?.find((d) => d.role === DestinationRole.PRIMARY) ??
        p.destinations?.[0];
      const dest = primary
        ? await this.destinations.findById(primary.destinationId)
        : null;
      const [last] = await this.jobs.findByPolicy(p.id);
      result.push({
        policyId: p.id,
        name: p.name,
        engineClass: p.engineClass,
        engine: p.engine ?? null,
        schedule: p.cronSchedule ?? null,
        enabled: p.enabled,
        status: p.status,
        destination: dest
          ? { id: dest.id, name: dest.name, provider: dest.provider }
          : null,
        lastRun: last
          ? {
              status: last.status,
              at:
                (
                  last.finishedAt ??
                  last.startedAt ??
                  last.createdAt
                )?.toISOString() ?? null,
              error: last.errorMessage ?? null,
            }
          : null,
        nextRunAt: p.enabled ? (p.nextRunAt?.toISOString() ?? null) : null,
      });
    }
    const coverage = await this.coverage.forApplicationId(applicationId);
    return {
      applicationId,
      // A policy whose last run failed has put nothing off the cluster, however
      // active it looks.
      protectedOffCluster: result.some(
        (p) =>
          p.enabled &&
          !!p.destination &&
          !FAILED_RUN.has(p.lastRun?.status ?? ''),
      ),
      policies: result,
      coverage,
      lastBackupSizeBytes: coverage?.policy
        ? await this.lastBackupSize(applicationId, coverage.policy.id)
        : null,
    };
  }

  private async lastBackupSize(
    applicationId: string,
    policyId: string,
  ): Promise<number | null> {
    const rows: Array<{
      jobId: string;
      at: Date | string;
      sizeBytes: string | null;
    }> = await this.artifacts
      .createQueryBuilder('a')
      .innerJoin(BackupJobEntity, 'j', 'j.id = a."backupJobId"')
      .select('a."backupJobId"', 'jobId')
      .addSelect('COALESCE(j."finishedAt", j."createdAt")', 'at')
      .addSelect('a."sizeBytes"', 'sizeBytes')
      .where('a."applicationId" = :applicationId', { applicationId })
      .andWhere('j."policyId" = :policyId', { policyId })
      .andWhere('j.status IN (:...statuses)', {
        statuses: [
          BackupJobStatus.COMPLETED,
          BackupJobStatus.PARTIALLY_COMPLETED,
        ],
      })
      .orderBy('at', 'DESC')
      .limit(50)
      .getRawMany();
    return latestCaptureSize(rows);
  }
}
