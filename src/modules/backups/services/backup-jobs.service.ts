import {
  BadRequestException,
  Optional,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupJobRepository } from '../repositories/backup-job.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupPoliciesService } from './backup-policies.service';
import { CreateBackupJobDto } from '../dto/create-backup-job.dto';
import {
  BackupJobStatus,
  BackupJobTriggerType,
} from '../enums/backup-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupAlertService } from './backup-alert.service';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';

export interface RunBackupJobData {
  backupJobId: string;
  operationId: string;
}

@Injectable()
export class BackupJobsService {
  private readonly logger = new Logger(BackupJobsService.name);

  constructor(
    private readonly jobRepo: BackupJobRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly policiesService: BackupPoliciesService,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
    @Optional() private readonly alerts?: BackupAlertService,
  ) {}

  async createOnDemand(
    userId: string,
    dto: CreateBackupJobDto,
    triggerType: BackupJobTriggerType = BackupJobTriggerType.ON_DEMAND,
  ): Promise<BackupJobEntity> {
    const policy = await this.policiesService.findById(dto.policyId);
    const jobType = this.jobTypeForClass(policy.engineClass);
    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.RUN_BACKUP_JOB,
        status: OperationStatus.PENDING,
        resourceType: 'backup_job',
        userId,
        metadata: { policyId: policy.id, clusterId: policy.clusterId },
        totalSteps: 6,
      }),
    );

    const entity = this.jobRepo.create({
      policyId: policy.id,
      clusterId: policy.clusterId,
      userId,
      triggerType,
      triggerContext: dto.metadata ?? {},
      status: BackupJobStatus.PENDING,
      scopeSnapshot: {
        scope: policy.scope,
        scopeSelector: policy.scopeSelector,
        includePvcs: policy.includePvcs,
      },
      infrastructureOperationId: op.id,
    });
    const saved = await this.jobRepo.save(entity);

    const jobData: RunBackupJobData = {
      backupJobId: saved.id,
      operationId: op.id,
    };
    await this.queue.add(jobType, jobData);
    return saved;
  }

  private jobTypeForClass(engineClass: BackupEngineClass): string {
    switch (engineClass) {
      case BackupEngineClass.DATABASE:
        return BACKUP_JOB_TYPES.RUN_DB_BACKUP;
      case BackupEngineClass.PLATFORM:
        return BACKUP_JOB_TYPES.RUN_PLATFORM_BACKUP;
      case BackupEngineClass.VOLUME_COPY:
        return BACKUP_JOB_TYPES.RUN_VOLUME_COPY;
      default:
        throw new BadRequestException(
          'This policy used the cluster backup engine Flui no longer has, so nothing can run it. ' +
            'Protect the cluster instead: every application then gets a policy of its own.',
        );
    }
  }

  /**
   * The job, with the artifact it produced attached — the restore wizard reads
   * `artifact.id` off this response to know what to restore (spec: a job has no
   * stored reference to its own artifact, only the artifact has a `backupJobId`
   * pointing back, so this is the one place that join has to happen).
   */
  async findById(
    id: string,
  ): Promise<BackupJobEntity & { artifact: BackupArtifactEntity | null }> {
    const job = await this.jobRepo.findById(id);
    if (!job) throw new NotFoundException(`BackupJob ${id} not found`);
    const artifact = await this.artifactRepo.findByJob(id);
    return { ...job, artifact };
  }

  async listByCluster(clusterId: string): Promise<BackupJobEntity[]> {
    return this.jobRepo.findByCluster(clusterId);
  }

  async listByPolicy(policyId: string): Promise<BackupJobEntity[]> {
    return this.jobRepo.findByPolicy(policyId);
  }

  async update(id: string, patch: Partial<BackupJobEntity>): Promise<void> {
    await this.jobRepo.update(id, patch);
    if (patch.status) void this.alerts?.settled(id, patch.status);
    if (
      patch.status === BackupJobStatus.COMPLETED ||
      patch.status === BackupJobStatus.PARTIALLY_COMPLETED
    ) {
      await this.refreshDestinationAfter(id);
    }
  }

  /**
   * What a destination holds is measured after something was written to it:
   * nothing else schedules the measurement, and an overview reading "0 B"
   * next to a backup that just landed says the backups are not there.
   */
  private async refreshDestinationAfter(jobId: string): Promise<void> {
    try {
      const job = await this.jobRepo.findById(jobId);
      const policy = job?.policyId
        ? await this.policiesService.findById(job.policyId)
        : null;
      const destinationId = policy
        ? this.policiesService.primaryDestinationOf(policy)?.destinationId
        : undefined;
      if (!destinationId) return;
      await this.queue.add(
        BACKUP_JOB_TYPES.HEALTH_CHECK_DESTINATION,
        { destinationId },
        { removeOnComplete: true, removeOnFail: true, attempts: 1 },
      );
    } catch (err: any) {
      this.logger.warn(
        `[backup-jobs] usage refresh not queued after job ${jobId}: ${err?.message}`,
      );
    }
  }
}
