import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  ApplicationMaterializerService,
  MaterializeOverrides,
} from '../../applications/services/application-materializer.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { HostnameMode } from '../../dns/enums/hostname-mode.enum';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import {
  AppCutoverMode,
  AppMigrationStatus,
} from '../enums/app-migration.enum';
import { CreateAppMigrationDto } from '../dto/create-app-migration.dto';
import {
  APP_MIGRATION_QUEUE,
  APP_MIGRATION_JOB_TYPES,
} from '../app-migration.constants';

@Injectable()
export class AppMigrationService {
  private readonly logger = new Logger(AppMigrationService.name);

  constructor(
    @InjectRepository(AppMigrationEntity)
    private readonly migRepo: Repository<AppMigrationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    @InjectQueue(APP_MIGRATION_QUEUE) private readonly queue: Queue,
    private readonly materializer: ApplicationMaterializerService,
  ) {}

  async create(
    userId: string,
    dto: CreateAppMigrationDto,
    opts?: {
      fullMigrationId?: string;
      provisionOverrides?: MaterializeOverrides;
    },
  ): Promise<AppMigrationEntity> {
    const app = await this.appRepo.findOne({ where: { id: dto.srcAppId } });
    if (!app) {
      throw new NotFoundException(`Application ${dto.srcAppId} not found`);
    }
    const cluster = await this.clusterRepo.findOne({
      where: { id: dto.targetClusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${dto.targetClusterId} not found`);
    }
    if (app.clusterId === dto.targetClusterId) {
      throw new BadRequestException(
        `Application ${dto.srcAppId} already runs on cluster ${dto.targetClusterId}`,
      );
    }

    // v1 scope (design D2/D3): stateless, self-contained, domain-mode only.
    if (app.volumes?.length) {
      throw new BadRequestException(
        `Application ${dto.srcAppId} has persistent volumes — v1 app-migration is stateless-only (move volume data via the volume/database backup classes)`,
      );
    }
    if (app.persistenceScope === 'dedicated') {
      throw new BadRequestException(
        `Application ${dto.srcAppId} uses dedicated node placement — not supported by v1 app-migration`,
      );
    }
    if (app.env?.some((e) => e.externalSecretRef)) {
      throw new BadRequestException(
        `Application ${dto.srcAppId} references external secrets (composed app) — migrate its producers first (v1 = self-contained only)`,
      );
    }

    // One migration per app at a time.
    const active = await this.migRepo.findOne({
      where: {
        srcAppId: dto.srcAppId,
        status: In([
          AppMigrationStatus.PENDING,
          AppMigrationStatus.PROVISIONING,
          AppMigrationStatus.READY,
          AppMigrationStatus.CUTOVER,
        ]),
      },
    });
    if (active) {
      throw new BadRequestException(
        `Application ${dto.srcAppId} already has an in-progress migration (${active.id})`,
      );
    }

    // IP-mode (nip.io) endpoints embed the source IP in the fqdn and cannot be
    // moved to a stable hostname — a domain-mode zone is required to migrate.
    const endpoints = await this.endpointRepo.find({
      where: { applicationId: dto.srcAppId },
    });
    if (endpoints.some((e) => e.hostnameMode === HostnameMode.IP)) {
      throw new BadRequestException(
        `Application ${dto.srcAppId} has an IP-mode (nip.io) endpoint bound to the source cluster IP — a domain-mode DNS zone is required to migrate`,
      );
    }

    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.MIGRATE_APPLICATION,
        status: OperationStatus.PENDING,
        resourceType: 'application',
        resourceName: app.name,
        resourceId: dto.srcAppId,
        userId,
        metadata: {
          srcClusterId: app.clusterId,
          targetClusterId: dto.targetClusterId,
        },
        totalSteps: 3,
      }),
    );

    const mig = await this.migRepo.save(
      this.migRepo.create({
        userId,
        srcAppId: dto.srcAppId,
        srcClusterId: app.clusterId,
        targetClusterId: dto.targetClusterId,
        cutoverMode: dto.cutover ?? AppCutoverMode.AUTO,
        status: AppMigrationStatus.PENDING,
        infrastructureOperationId: op.id,
        fullMigrationId: opts?.fullMigrationId,
        provisionOverrides: opts?.provisionOverrides,
      }),
    );
    await this.queue.add(APP_MIGRATION_JOB_TYPES.RUN_APP_MIGRATION, {
      migrationId: mig.id,
    });
    this.logger.log(
      `[app-migration] ${mig.id}: app ${dto.srcAppId} ${app.clusterId} → ${dto.targetClusterId} (cutover ${mig.cutoverMode})`,
    );
    return mig;
  }

  async cutover(
    id: string,
    fromOrchestrator = false,
  ): Promise<AppMigrationEntity> {
    const mig = await this.findById(id);
    this.assertNotOrchestrated(mig, fromOrchestrator);
    if (mig.status !== AppMigrationStatus.READY) {
      throw new BadRequestException(
        `Cutover is only available in state '${AppMigrationStatus.READY}' (current: '${mig.status}')`,
      );
    }
    await this.queue.add(APP_MIGRATION_JOB_TYPES.RUN_APP_CUTOVER, {
      migrationId: id,
    });
    return mig;
  }

  private assertNotOrchestrated(
    mig: AppMigrationEntity,
    fromOrchestrator: boolean,
  ): void {
    if (mig.fullMigrationId && !fromOrchestrator) {
      throw new BadRequestException(
        `Migration ${mig.id} is a leg of full-migration ${mig.fullMigrationId} — drive it through the full-migration, not directly`,
      );
    }
  }

  /**
   * Tear the migration down pre-cutover: delete the destination workload. The
   * source app is untouched (it never left its cluster before cutover). Guarded
   * by the app's current cluster — if it has already been re-bound to the
   * destination (cutover done/underway) the destination is live and is NOT
   * torn down.
   */
  async abort(
    id: string,
    fromOrchestrator = false,
  ): Promise<AppMigrationEntity> {
    const mig = await this.findById(id);
    this.assertNotOrchestrated(mig, fromOrchestrator);
    const abortable = [
      AppMigrationStatus.PENDING,
      AppMigrationStatus.PROVISIONING,
      AppMigrationStatus.READY,
      AppMigrationStatus.FAILED,
    ];
    if (!abortable.includes(mig.status)) {
      throw new BadRequestException(
        `Migration in state '${mig.status}' cannot be aborted`,
      );
    }
    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    // Only tear down inline when no materialize is in flight; while PROVISIONING
    // the processor re-applies concurrently, so it tears the destination down
    // itself once it observes ABORTED after materialize returns (avoids a
    // delete-vs-apply race). The `clusterId !== target` guard never tears down a
    // destination the app has already been re-bound to (cutover done/underway).
    if (
      mig.status !== AppMigrationStatus.PROVISIONING &&
      app &&
      app.clusterId !== mig.targetClusterId
    ) {
      await this.materializer
        .teardownOnCluster(app, mig.targetClusterId)
        .catch((err: unknown) =>
          this.logger.warn(
            `[app-migration] abort ${id}: destination teardown failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }
    mig.status = AppMigrationStatus.ABORTED;
    mig.finishedAt = new Date();
    await this.migRepo.save(mig);
    if (mig.infrastructureOperationId) {
      await this.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.CANCELLED,
        completedAt: new Date(),
      });
    }
    this.logger.log(`[app-migration] aborted ${id}`);
    return mig;
  }

  /**
   * Tear the drained SOURCE workload down after a successful cutover (plan §6
   * step 9 DESTROY). Only valid once the app has been re-bound to the
   * destination — never touches a live serving cluster.
   */
  async destroySource(id: string): Promise<AppMigrationEntity> {
    const mig = await this.findById(id);
    if (mig.status !== AppMigrationStatus.COMPLETED) {
      throw new BadRequestException(
        `Source can only be destroyed after a COMPLETED migration (current: '${mig.status}')`,
      );
    }
    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    if (app?.clusterId !== mig.targetClusterId) {
      throw new BadRequestException(
        `Application ${mig.srcAppId} is not bound to the migration target — refusing to destroy`,
      );
    }
    await this.materializer.teardownOnCluster(app, mig.srcClusterId);
    this.logger.log(
      `[app-migration] ${id}: destroyed drained source on cluster ${mig.srcClusterId}`,
    );
    return mig;
  }

  async findById(id: string): Promise<AppMigrationEntity> {
    const mig = await this.migRepo.findOne({ where: { id } });
    if (!mig) throw new NotFoundException(`Migration ${id} not found`);
    return mig;
  }

  async list(userId: string): Promise<AppMigrationEntity[]> {
    return this.migRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }
}
