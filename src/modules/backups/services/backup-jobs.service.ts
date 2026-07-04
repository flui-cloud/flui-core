import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { BackupJobEntity } from '../entities/backup-job.entity';
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
  ) {}

  async createOnDemand(
    userId: string,
    dto: CreateBackupJobDto,
  ): Promise<BackupJobEntity> {
    const policy = await this.policiesService.findById(dto.policyId);
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
      triggerType: BackupJobTriggerType.ON_DEMAND,
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

    const jobType = this.jobTypeForClass(policy.engineClass);
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
      default:
        return BACKUP_JOB_TYPES.RUN_BACKUP;
    }
  }

  async createPreDeploy(params: {
    userId: string;
    clusterId: string;
    applicationId: string;
    deployId: string;
    namespace: string;
  }): Promise<{ job: BackupJobEntity; operationId: string }> {
    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.PRE_DEPLOY_SNAPSHOT,
        status: OperationStatus.PENDING,
        resourceType: 'backup_job',
        userId: params.userId,
        metadata: { ...params },
        totalSteps: 3,
      }),
    );

    const entity = this.jobRepo.create({
      clusterId: params.clusterId,
      userId: params.userId,
      triggerType: BackupJobTriggerType.PRE_DEPLOY,
      triggerContext: {
        applicationId: params.applicationId,
        deployId: params.deployId,
        namespace: params.namespace,
      },
      status: BackupJobStatus.PENDING,
      scopeSnapshot: { namespace: params.namespace },
      infrastructureOperationId: op.id,
    });
    const saved = await this.jobRepo.save(entity);

    await this.queue.add(BACKUP_JOB_TYPES.PRE_DEPLOY_SNAPSHOT, {
      backupJobId: saved.id,
      operationId: op.id,
    });
    return { job: saved, operationId: op.id };
  }

  async findById(id: string): Promise<BackupJobEntity> {
    const job = await this.jobRepo.findById(id);
    if (!job) throw new NotFoundException(`BackupJob ${id} not found`);
    return job;
  }

  async listByCluster(clusterId: string): Promise<BackupJobEntity[]> {
    return this.jobRepo.findByCluster(clusterId);
  }

  async update(id: string, patch: Partial<BackupJobEntity>): Promise<void> {
    await this.jobRepo.update(id, patch);
  }
}
