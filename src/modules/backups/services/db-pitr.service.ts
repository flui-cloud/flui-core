import { RESTORE_POINT_KIND } from '../utils/restore-point.util';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { RestoreJobsService } from './restore-jobs.service';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';
import { RestoreJobEntity } from '../entities/restore-job.entity';
import { RestoreTargetKind } from '../enums/restore-job.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { DbPitrRestoreDto } from '../dto/db-pitr-restore.dto';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';

export interface DbPitrStatus {
  applicationId: string;
  continuousBackupEnabled: boolean;
  /** The engine protecting it; `*-dump` restores whole dumps, not moments. */
  engine: string | null;
  pointInTime: boolean;
  policyId: string | null;
  cronSchedule: string | null;
  backupCount: number;
  /** [oldest, newest] recoverable window; newest is the last archived change. */
  window: { oldest: string | null; newest: string | null } | null;
  lastBackup: { engineRef: string | null; at: string } | null;
  latestArtifactId: string | null;
  sourceDestinationId: string | null;
}

/**
 * Read-only PITR status for a DB app tab, plus the "restore as of" action. Gating
 * is the caller's AppOwnershipGuard (per-app); this service assumes access checked.
 */
@Injectable()
export class DbPitrService {
  private readonly logger = new Logger(DbPitrService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly policyRepo: BackupPolicyRepository,
    private readonly restoreJobs: RestoreJobsService,
    private readonly engines: ContinuousBackupEngineRegistry,
    @InjectRepository(BackupJobEntity)
    private readonly jobRepo: Repository<BackupJobEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
  ) {}

  async status(appId: string): Promise<DbPitrStatus> {
    const policy = await this.policyRepo.findDbPolicyForApp(appId);
    const artifact = await this.artifactRepo.findLatestDbArtifactForApp(appId);

    // The repo window comes from a live pod; tolerate a stopped/absent pod.
    // Through the engine the policy recorded, because asking pgBackRest about
    // a MariaDB fails inside the catch below and reports an empty window on a
    // database that has one — a understatement that reads as "unprotected".
    let backupCount = 0;
    let window: DbPitrStatus['window'] = null;
    const engine = policy ? this.engines.forEngine(policy.engine) : null;
    try {
      const info = await this.engines.forEngine(policy?.engine).info(appId);
      backupCount = info.backupCount;
      window = {
        oldest: info.oldestRecoverable,
        newest: info.newestRecoverable,
      };
    } catch (err: any) {
      this.logger.debug(
        `[db-pitr] info unavailable for app=${appId}: ${err?.message}`,
      );
    }

    return {
      applicationId: appId,
      continuousBackupEnabled: !!policy?.enabled,
      engine: engine?.engine ?? null,
      pointInTime: engine ? engine.pointInTime !== false : true,
      policyId: policy?.id ?? null,
      cronSchedule: policy?.cronSchedule ?? null,
      backupCount,
      window,
      lastBackup: artifact
        ? {
            engineRef: artifact.engineRef ?? null,
            at: artifact.createdAt.toISOString(),
          }
        : null,
      latestArtifactId: artifact?.id ?? null,
      sourceDestinationId: this.primaryDestinationOf(artifact),
    };
  }

  async restore(
    userId: string,
    appId: string,
    dto: DbPitrRestoreDto,
  ): Promise<RestoreJobEntity> {
    // The base a point-in-time recovery replays from has to predate the
    // moment asked for. Taking the newest one regardless looks right and is
    // not: the replay would start from a position already past the target,
    // apply nothing, and hand back state from after the moment it reports.
    const at = dto.recoveryTargetTime
      ? new Date(dto.recoveryTargetTime)
      : undefined;
    const artifact = at
      ? await this.artifactRepo.findDbArtifactForAppAt(appId, at)
      : await this.artifactRepo.findLatestDbArtifactForApp(appId);
    if (!artifact) {
      throw new NotFoundException(
        at
          ? `No database backup of this application had been taken by ${at.toISOString()}. ` +
            'Recovery cannot reach back before the first one.'
          : 'No database backup found for this application',
      );
    }
    const sourceDestinationId = this.primaryDestinationOf(artifact);
    if (!sourceDestinationId) {
      throw new NotFoundException(
        'Backup has no primary destination to restore from',
      );
    }
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const clusterId = dto.clusterId ?? app.clusterId;

    return this.restoreJobs.create(userId, {
      artifactId: artifact.id,
      sourceDestinationId,
      targetClusterId: clusterId,
      targetKind: RestoreTargetKind.DATABASE,
      targetSelector: { newInstall: { name: dto.name, clusterId } },
      recoveryTargetTime: dto.recoveryTargetTime,
    });
  }

  /**
   * Restore a database from one of its backups, whether or not the database
   * still exists — the case the backup exists for. Only the person whose
   * backup it is may restore it; the new install lands on the named cluster,
   * or on the source's cluster while that cluster is still there.
   */
  async restoreArtifact(
    userId: string,
    artifactId: string,
    dto: DbPitrRestoreDto,
  ): Promise<RestoreJobEntity> {
    const artifact = await this.artifactRepo.findArtifact(artifactId);
    const job = artifact?.backupJobId
      ? await this.jobRepo.findOne({ where: { id: artifact.backupJobId } })
      : null;
    if (!artifact || job?.userId !== userId) {
      throw new NotFoundException(`Backup ${artifactId} not found`);
    }
    if (artifact.engineClass !== BackupEngineClass.DATABASE) {
      throw new BadRequestException(
        'This backup is not a database backup; restore it from the cluster or the application instead.',
      );
    }
    if (artifact.manifestSummary?.kind === RESTORE_POINT_KIND) {
      return this.restoreToPoint(userId, artifact.manifestSummary, dto);
    }
    const sourceDestinationId = this.primaryDestinationOf(artifact);
    if (!sourceDestinationId) {
      throw new NotFoundException(
        'Backup has no primary destination to restore from',
      );
    }
    const clusterId =
      dto.clusterId ??
      ((await this.clusterRepo.exists({ where: { id: artifact.clusterId } }))
        ? artifact.clusterId
        : undefined);
    if (!clusterId) {
      throw new BadRequestException(
        'The cluster this database ran on no longer exists: choose the cluster to restore it into.',
      );
    }
    return this.restoreJobs.create(userId, {
      artifactId: artifact.id,
      sourceDestinationId,
      targetClusterId: clusterId,
      targetKind: RestoreTargetKind.DATABASE,
      targetSelector: { newInstall: { name: dto.name, clusterId } },
      recoveryTargetTime: dto.recoveryTargetTime,
    });
  }

  /**
   * A restore point is a moment inside the database's own backup, not a backup:
   * restoring it means the newest base that finished before the moment,
   * replayed up to it.
   */
  private async restoreToPoint(
    userId: string,
    point: Record<string, any>,
    dto: DbPitrRestoreDto,
  ): Promise<RestoreJobEntity> {
    const at = new Date(dto.recoveryTargetTime ?? point.recoverTo);
    const base = await this.artifactRepo.findDbArtifactForAppAt(
      String(point.restorePointFor ?? ''),
      at,
    );
    if (!base) {
      throw new BadRequestException(
        'No base backup of this database finished before that restore point, so there is nothing to replay up to it.',
      );
    }
    return this.restoreArtifact(userId, base.id, {
      ...dto,
      recoveryTargetTime: at.toISOString(),
    });
  }

  private primaryDestinationOf(
    artifact: {
      locations?: { role: DestinationRole; destinationId: string }[];
    } | null,
  ): string | null {
    const primary = artifact?.locations?.find(
      (l) => l.role === DestinationRole.PRIMARY,
    );
    return (
      primary?.destinationId ?? artifact?.locations?.[0]?.destinationId ?? null
    );
  }
}
