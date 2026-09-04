import {
  BadRequestException,
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
import { DestinationRole } from '../enums/destination-role.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { VeleroInstallerService } from '../services/velero-installer.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { DeclaredEngineResolver } from '../services/declared-engine.resolver';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

/**
 * The permissions on the routes an agent reaches take nothing from anybody:
 * entering the `backup` section at `full` is already `cluster:manage` at global
 * scope, and every role that holds it holds `cluster:read`. They are there for
 * the credential ceiling, which reads `@RequirePermission` and `@AppAction` and
 * nothing else — without them a key scoped to "look at backups"
 * pauses a policy and fires a job over plain HTTP.
 */
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
    private readonly destinations: BackupDestinationRepository,
    private readonly declaredEngines: DeclaredEngineResolver,
  ) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  /**
   * Continuous backup for one database, configured before it is recorded.
   *
   * Separate from `POST /` because the order differs and the order is the
   * feature: that path saves the policy and lets the first scheduled run
   * discover whether the engine works, so a wrong destination or an image
   * without pgBackRest surfaces hours later as a failed job. This one
   * configures pgBackRest first, so the failure is the answer to the request
   * that asked for it, and no policy is left behind describing protection that
   * was never set up.
   */
  @Post('enable-database')
  async enableDatabase(
    @Req() req: Request,
    @Body() dto: CreateBackupPolicyDto,
  ) {
    const primary = dto.destinations.find(
      (d) => d.role === DestinationRole.PRIMARY,
    );
    const destination = primary
      ? await this.destinations.findById(primary.destinationId)
      : null;
    if (!destination) {
      throw new BadRequestException(
        'A PRIMARY destination is required, and it must exist',
      );
    }

    const declaredEngine = await this.declaredEngines.resolveForApp(
      dto.scopeSelector?.applicationIds?.[0] ?? '',
    );

    const policy = await this.service.enableDatabase(
      this.userId(req),
      { ...dto, engineClass: BackupEngineClass.DATABASE },
      destination,
      declaredEngine,
    );

    // WAL is archiving from the moment the engine was enabled, but WAL alone
    // restores nothing: it has to be replayed onto a base backup. Taking the
    // first one now is what makes "enabled" and "recoverable" the same moment.
    await this.jobsService.createOnDemand(policy.userId, {
      policyId: policy.id,
    });
    return policy;
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
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
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
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  // An "always" here covers this one policy and no other. Asked of pausing and
  // not of resuming, because only pausing leaves data unprotected.
  @ActionCycle({
    action: 'POST /backup-policies/:id/pause',
    bind: ['id'],
    sentence: 'stop backup policy {id} from running',
    consequence:
      'No backup is taken under this policy until somebody resumes it, so everything written meanwhile is unprotected.',
  })
  async pause(@Param('id') id: string) {
    return this.service.pause(id);
  }

  @Post(':id/resume')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
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
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { ok: true };
  }
}
