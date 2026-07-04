import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupPoliciesService } from '../services/backup-policies.service';
import { BackupJobsService } from '../services/backup-jobs.service';
import { CreateBackupPolicyDto } from '../dto/create-backup-policy.dto';
import { SetPlatformConfigDto } from '../dto/set-platform-config.dto';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { VeleroInstallerService } from '../services/velero-installer.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('backup-policies')
@RequireSection('backup')
export class BackupPoliciesController {
  constructor(
    private readonly service: BackupPoliciesService,
    private readonly jobsService: BackupJobsService,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly installer: VeleroInstallerService,
    private readonly encryption: EncryptionService,
  ) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateBackupPolicyDto) {
    const policy = await this.service.create(this.userId(req), dto);

    if (policy.engineClass === BackupEngineClass.DATABASE) {
      // Database-class policies drive pgBackRest inside the postgres pod — no
      // Velero. Creating one enables continuous backup and takes the first base
      // backup (idempotent, self-healing on every run).
      await this.jobsService.createOnDemand(policy.userId, {
        policyId: policy.id,
      });
    } else {
      await this.ensureVeleroInstall(policy);
    }
    return policy;
  }

  private async ensureVeleroInstall(policy: BackupPolicyEntity): Promise<void> {
    const cluster = await this.clusterRepo.findOne({
      where: { id: policy.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) return;
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    if (await this.installer.isInstalled(kubeconfig)) return;

    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.INSTALL_VELERO,
        status: OperationStatus.PENDING,
        resourceType: 'cluster',
        resourceId: policy.clusterId,
        userId: policy.userId,
        metadata: { policyId: policy.id },
        totalSteps: 9,
      }),
    );
    await this.queue.add(BACKUP_JOB_TYPES.INSTALL_VELERO, {
      clusterId: policy.clusterId,
      destinationIds: policy.destinations.map((d) => d.destinationId),
      primaryDestinationId:
        this.service.primaryDestinationOf(policy).destinationId,
      operationId: op.id,
    });
  }

  @Get()
  async list(@Req() req: Request) {
    return this.service.list(this.userId(req));
  }

  @Get('cluster/:clusterId')
  async listByCluster(@Param('clusterId') clusterId: string) {
    return this.service.listByCluster(clusterId);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/pause')
  async pause(@Param('id') id: string) {
    return this.service.pause(id);
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string) {
    return this.service.resume(id);
  }

  @Post(':id/platform-config')
  async setPlatformConfig(
    @Param('id') id: string,
    @Body() dto: SetPlatformConfigDto,
  ) {
    return this.service.setPlatformConfig(id, {
      recipient: dto.recipient,
      heartbeatUrl: dto.heartbeatUrl,
    });
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { ok: true };
  }
}
