import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  BackupJobsService,
  RunBackupJobData,
} from '../services/backup-jobs.service';
import { BackupPoliciesService } from '../services/backup-policies.service';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import {
  PgBackrestService,
  PgBackupInfo,
} from '../services/pgbackrest.service';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';

@Processor(BACKUP_QUEUE)
export class RunDbBackupProcessor {
  private readonly logger = new Logger(RunDbBackupProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly jobsService: BackupJobsService,
    private readonly policiesService: BackupPoliciesService,
    private readonly destRepo: BackupDestinationRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly pgbackrest: PgBackrestService,
  ) {}

  @Process(BACKUP_JOB_TYPES.RUN_DB_BACKUP)
  async handle(job: Job<RunBackupJobData>): Promise<void> {
    const { backupJobId, operationId } = job.data;
    this.logger.log(`[run-db-backup] Starting backupJob=${backupJobId}`);

    const setStep = async (step: OperationStep, progress: number) => {
      await this.opRepo.update(operationId, {
        currentStep: step,
        progress,
        status: OperationStatus.IN_PROGRESS,
        startedAt: progress <= 10 ? new Date() : undefined,
      });
    };

    try {
      const backupJob = await this.jobsService.findById(backupJobId);
      if (!backupJob.policyId) {
        throw new Error('database backup job has no policy');
      }
      const policy = await this.policiesService.findById(backupJob.policyId);
      const appId = policy.scopeSelector?.applicationIds?.[0];
      if (!appId) {
        throw new Error(
          'database policy scopeSelector.applicationIds[0] is required',
        );
      }
      const primaryDest = this.policiesService.primaryDestinationOf(policy);
      const destEntity = await this.destRepo.findById(
        primaryDest.destinationId,
      );
      if (!destEntity) throw new Error('primary destination not found');

      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.RUNNING,
        startedAt: new Date(),
      });

      await setStep(OperationStep.BACKUP_RUN_RESOLVE_SCOPE, 10);

      // Idempotent + self-healing: (re)write conf, ensure the stanza exists, flip
      // archive_command. No restart (see D1/D2). Cheap next to the base backup.
      await this.pgbackrest.enable(appId, destEntity, {
        retentionFull: policy.retentionMaxCopies ?? 2,
      });

      const before = await this.pgbackrest.info(appId);
      const type = this.chooseBackupType(before, policy);

      await setStep(OperationStep.BACKUP_RUN_RECORD_ARTIFACT, 40);
      const label = await this.pgbackrest.baseBackup(appId, type);
      const info = await this.pgbackrest.info(appId);

      // pgUser/pgDb ride the artifact so a restore still knows how to boot the
      // clone when the source app (or its whole cluster) no longer exists —
      // the disaster-recovery case.
      const target = await this.pgbackrest.resolveTarget(appId);
      // Read from the running server, not assumed from the seed: the restore
      // installs whatever tag the catalog carries at restore time, and a data
      // directory does not open under a different major. Recorded here so the
      // mismatch is visible before a recovery rather than during one.
      const facts = await this.pgbackrest.describeForArtifact(appId);
      const artifact = this.artifactRepo.createArtifact({
        backupJobId,
        clusterId: backupJob.clusterId,
        engineClass: BackupEngineClass.DATABASE,
        // On the column, not only inside `manifestSummary`: the ledger's whole
        // point is that "what protects this application" is one query, and a
        // database artifact that answers only from a jsonb blob is invisible
        // to it.
        applicationId: appId,
        engine: facts.engine,
        engineVersion: facts.engineVersion,
        engineRef: label,
        manifestSummary: {
          applicationId: appId,
          backupType: type,
          tool: facts.tool,
          toolVersion: facts.toolVersion,
          catalogSlug: facts.catalogSlug,
          pgUser: target.pgUser,
          pgDb: target.pgDb,
          oldestRecoverable: info.oldestRecoverable,
          newestRecoverable: info.newestRecoverable,
          backupCount: info.backupCount,
        },
        expiresAt: policy.retentionDays
          ? new Date(Date.now() + policy.retentionDays * 86_400_000)
          : undefined,
      });
      const saved = await this.artifactRepo.saveArtifact(artifact);

      const loc: Partial<BackupArtifactLocationEntity> = {
        artifactId: saved.id,
        destinationId: destEntity.id,
        role: DestinationRole.PRIMARY,
        state: ArtifactLocationState.AVAILABLE,
        // Relative to pathPrefix — pgbackrest's own repo1-path already
        // includes it (see PgbackrestService.repoPath), and getUsage()/
        // listObjects() re-prepend it via joinPrefix, so it must not be here.
        objectKeyPrefix: `pgbackrest/${appId}/`,
      };
      await this.artifactRepo.saveLocation(loc as BackupArtifactLocationEntity);

      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.COMPLETED,
        finishedAt: new Date(),
        metadata: { engineRef: label, backupType: type },
      });

      await setStep(OperationStep.BACKUP_RUN_FINALIZE, 100);
      await this.opRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        completedAt: new Date(),
        progress: 100,
      });
      this.logger.log(
        `[run-db-backup] Completed backupJob=${backupJobId} label=${label} type=${type}`,
      );
    } catch (err: any) {
      this.logger.error(`[run-db-backup] Failed: ${err?.message}`);
      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        finishedAt: new Date(),
      });
      await this.opRepo.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        completedAt: new Date(),
      });
      throw err;
    }
  }

  /**
   * Retention counts FULL backups, so an endless incr chain would never expire
   * and would pin the WAL archive forever — force a new full on a cadence
   * (policy metadata `fullEveryDays`, default 7) so the repo can rotate.
   */
  private chooseBackupType(
    info: PgBackupInfo,
    policy: BackupPolicyEntity,
  ): 'full' | 'incr' {
    if (info.backupCount === 0 || !info.lastFullAt) return 'full';
    const fullEveryDays = Number(policy.metadata?.fullEveryDays) || 7;
    const ageMs = Date.now() - new Date(info.lastFullAt).getTime();
    return ageMs >= fullEveryDays * 86_400_000 ? 'full' : 'incr';
  }
}
