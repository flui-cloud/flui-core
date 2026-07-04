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
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { PlatformBackupService } from '../services/platform-backup.service';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { EncryptionMode } from '../enums/destination-health.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';

@Processor(BACKUP_QUEUE)
export class RunPlatformBackupProcessor {
  private readonly logger = new Logger(RunPlatformBackupProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly jobsService: BackupJobsService,
    private readonly policiesService: BackupPoliciesService,
    private readonly destRepo: BackupDestinationRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly platformBackup: PlatformBackupService,
  ) {}

  @Process(BACKUP_JOB_TYPES.RUN_PLATFORM_BACKUP)
  async handle(job: Job<RunBackupJobData>): Promise<void> {
    const { backupJobId, operationId } = job.data;
    this.logger.log(`[run-platform-backup] Starting backupJob=${backupJobId}`);

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
        throw new Error('platform backup job has no policy');
      }
      const policy = await this.policiesService.findById(backupJob.policyId);
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

      const result = await this.platformBackup.execute(policy, destEntity);

      await setStep(OperationStep.BACKUP_RUN_RECORD_ARTIFACT, 70);
      const expiresAt = policy.retentionDays
        ? new Date(Date.now() + policy.retentionDays * 86_400_000)
        : undefined;

      await this.recordArtifact(
        backupJobId,
        backupJob.clusterId,
        destEntity.id,
        {
          engineRef: 'platform:db',
          objectKey: result.dbObjectKey,
          sizeBytes: result.dbSizeBytes,
          expiresAt,
          manifestSummary: {
            kind: 'platform-db-dump',
            databases: result.databases,
            zitadelCovered: result.zitadelCovered,
            insecureDefaults: result.insecureDefaults,
            encryptionKeyFingerprint: result.encryptionKeyFingerprint,
          },
        },
      );
      await this.recordArtifact(
        backupJobId,
        backupJob.clusterId,
        destEntity.id,
        {
          engineRef: 'platform:keys',
          objectKey: result.keysObjectKey,
          sizeBytes: result.keysSizeBytes,
          expiresAt,
          manifestSummary: {
            kind: 'platform-key-bundle',
            sealedTo: 'operator-age-recipient',
            encryptionKeyFingerprint: result.encryptionKeyFingerprint,
          },
        },
      );

      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.COMPLETED,
        finishedAt: new Date(),
        metadata: {
          databases: result.databases,
          zitadelCovered: result.zitadelCovered,
          insecureDefaults: result.insecureDefaults,
        },
      });
      await setStep(OperationStep.BACKUP_RUN_FINALIZE, 100);
      await this.opRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        completedAt: new Date(),
        progress: 100,
      });
      this.logger.log(
        `[run-platform-backup] Completed backupJob=${backupJobId} ` +
          `dbs=${result.databases.length} zitadelCovered=${result.zitadelCovered} ` +
          `insecureDefaults=${result.insecureDefaults.length}`,
      );
    } catch (err: any) {
      this.logger.error(`[run-platform-backup] Failed: ${err?.message}`);
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

  private async recordArtifact(
    backupJobId: string,
    clusterId: string,
    destinationId: string,
    data: {
      engineRef: string;
      objectKey: string;
      sizeBytes: number;
      expiresAt?: Date;
      manifestSummary: Record<string, unknown>;
    },
  ): Promise<void> {
    const artifact = this.artifactRepo.createArtifact({
      backupJobId,
      clusterId,
      engineClass: BackupEngineClass.PLATFORM,
      engineRef: data.engineRef,
      encryptionMode: EncryptionMode.OPERATOR,
      sizeBytes: String(data.sizeBytes),
      expiresAt: data.expiresAt,
      manifestSummary: data.manifestSummary,
    });
    const saved = await this.artifactRepo.saveArtifact(artifact);
    const loc: Partial<BackupArtifactLocationEntity> = {
      artifactId: saved.id,
      destinationId,
      role: DestinationRole.PRIMARY,
      state: ArtifactLocationState.AVAILABLE,
      objectKeyPrefix: data.objectKey,
    };
    await this.artifactRepo.saveLocation(loc as BackupArtifactLocationEntity);
  }
}
