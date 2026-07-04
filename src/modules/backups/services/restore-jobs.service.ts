import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RestoreJobRepository } from '../repositories/restore-job.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import {
  CreateRestoreJobDto,
  RestorePreviewDto,
} from '../dto/create-restore-job.dto';
import { RestoreJobEntity } from '../entities/restore-job.entity';
import {
  RestoreJobStatus,
  RestoreTargetKind,
  RestoreStrategy,
} from '../enums/restore-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';
import { BackupDestinationsService } from './backup-destinations.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';

@Injectable()
export class RestoreJobsService {
  private readonly logger = new Logger(RestoreJobsService.name);

  constructor(
    private readonly repo: RestoreJobRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
    private readonly destinationsService: BackupDestinationsService,
    private readonly storageFactory: StorageBackendFactory,
  ) {}

  async preview(dto: RestorePreviewDto): Promise<Record<string, any>> {
    const artifact = await this.artifactRepo.findArtifact(dto.artifactId);
    if (!artifact)
      throw new NotFoundException(`Artifact ${dto.artifactId} not found`);
    const loc = await this.artifactRepo.findLocation(
      dto.artifactId,
      dto.sourceDestinationId,
    );
    if (loc?.state !== ArtifactLocationState.AVAILABLE) {
      throw new NotFoundException(
        `No AVAILABLE location for artifact ${dto.artifactId} on destination ${dto.sourceDestinationId}`,
      );
    }
    const dest = await this.destinationsService.findById(
      dto.sourceDestinationId,
    );
    const backend = this.storageFactory.forProvider(dest.provider);
    const creds = this.destinationsService.toCredentials(dest);
    const usage = await backend.getUsage(creds, loc.objectKeyPrefix);
    return {
      veleroBackupName: artifact.veleroBackupName,
      manifestSummary: artifact.manifestSummary,
      sizeBytes: artifact.sizeBytes,
      itemCount: artifact.itemCount,
      sourceDestinationId: dest.id,
      objectsAtPrefix: usage.objectCount,
      bytesAtPrefix: usage.bytes,
    };
  }

  async create(
    userId: string,
    dto: CreateRestoreJobDto,
  ): Promise<RestoreJobEntity> {
    const artifact = await this.artifactRepo.findArtifact(dto.artifactId);
    if (!artifact)
      throw new NotFoundException(`Artifact ${dto.artifactId} not found`);

    if (artifact.engineClass === BackupEngineClass.PLATFORM) {
      throw new BadRequestException(
        'Platform (master) artifacts are operator-sealed and cannot be restored through this pipeline. ' +
          'Recover them offline with your age identity per the cold-rebuild runbook.',
      );
    }

    const isDb = dto.targetKind === RestoreTargetKind.DATABASE;
    if (isDb) {
      if (artifact.engineClass !== BackupEngineClass.DATABASE) {
        throw new BadRequestException(
          'Artifact is not a database-class backup',
        );
      }
      const newInstall = dto.targetSelector?.newInstall;
      if (!newInstall?.name || !newInstall?.clusterId) {
        throw new BadRequestException(
          'Database restore requires targetSelector.newInstall { name, clusterId }',
        );
      }
    }

    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.RUN_RESTORE_JOB,
        status: OperationStatus.PENDING,
        resourceType: 'restore_job',
        userId,
        metadata: { artifactId: dto.artifactId },
        totalSteps: 5,
      }),
    );

    const entity = this.repo.create({
      userId,
      artifactId: dto.artifactId,
      sourceDestinationId: dto.sourceDestinationId,
      targetClusterId: dto.targetClusterId,
      targetKind: dto.targetKind,
      targetSelector: dto.targetSelector ?? {},
      strategy: isDb ? RestoreStrategy.PG_PITR : dto.strategy,
      recoveryTargetTime: dto.recoveryTargetTime
        ? new Date(dto.recoveryTargetTime)
        : undefined,
      status: RestoreJobStatus.PENDING,
      infrastructureOperationId: op.id,
    });
    const saved = await this.repo.save(entity);

    await this.queue.add(
      isDb ? BACKUP_JOB_TYPES.RUN_DB_RESTORE : BACKUP_JOB_TYPES.RUN_RESTORE,
      {
        restoreJobId: saved.id,
        operationId: op.id,
      },
    );
    return saved;
  }

  async findById(id: string): Promise<RestoreJobEntity> {
    const job = await this.repo.findById(id);
    if (!job) throw new NotFoundException(`RestoreJob ${id} not found`);
    return job;
  }

  async listByUser(userId: string): Promise<RestoreJobEntity[]> {
    return this.repo.findByUser(userId);
  }
}
