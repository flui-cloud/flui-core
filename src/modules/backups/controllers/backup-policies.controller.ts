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
import { CreateBackupPolicyDto } from '../dto/create-backup-policy.dto';
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

    // Lazy install: if Velero not yet installed on target cluster, enqueue install job
    const cluster = await this.clusterRepo.findOne({
      where: { id: policy.clusterId },
    });
    if (cluster?.kubeconfigEncrypted) {
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
      const installed = await this.installer.isInstalled(kubeconfig);
      if (!installed) {
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
        const primaryDest = this.service.primaryDestinationOf(policy);
        await this.queue.add(BACKUP_JOB_TYPES.INSTALL_VELERO, {
          clusterId: policy.clusterId,
          destinationIds: policy.destinations.map((d) => d.destinationId),
          primaryDestinationId: primaryDest.destinationId,
          operationId: op.id,
        });
      }
    }
    return policy;
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

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { ok: true };
  }
}
