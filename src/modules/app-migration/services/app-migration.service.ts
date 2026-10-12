import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
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
import { AppVolumeTransferService } from './app-volume-transfer.service';
import {
  APP_MIGRATION_QUEUE,
  APP_MIGRATION_JOB_TYPES,
} from '../app-migration.constants';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { EndpointBridgeService } from '../../dns/services/endpoint-bridge.service';
import { AppMigrationProcessor } from '../processors/app-migration.processor';
import { MigrationBridgeView, bridgeView } from '../utils/bridge-view';
import {
  assertNotOrchestrated,
  canResumeCutover,
} from '../utils/app-migration-state.core';
import { AppMigrationJobs } from './app-migration.jobs';
import { AppMigrationTeardown } from './app-migration.teardown';

export type AppMigrationView = Omit<AppMigrationEntity, 'bridgeState'> & {
  bridge: MigrationBridgeView | null;
  canResumeCutover: boolean;
};

@Injectable()
export class AppMigrationService implements OnModuleInit {
  private readonly logger = new Logger(AppMigrationService.name);
  private readonly jobs: AppMigrationJobs;
  private readonly teardown: AppMigrationTeardown;

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
    materializer: ApplicationMaterializerService,
    private readonly volumes: AppVolumeTransferService,
    reconciliation: AppEndpointReconciliationService,
    private readonly bridge: EndpointBridgeService,
    private readonly legs: AppMigrationProcessor,
  ) {
    this.jobs = new AppMigrationJobs(queue, migRepo, this.logger);
    this.teardown = new AppMigrationTeardown(
      migRepo,
      opRepo,
      endpointRepo,
      materializer,
      reconciliation,
      bridge,
      this.logger,
    );
  }

  async create(
    userId: string,
    dto: CreateAppMigrationDto,
    opts?: {
      fullMigrationId?: string;
      provisionOverrides?: MaterializeOverrides;
      /** The Secret of the database moving with this app, which its env may read. */
      allowSecretsOf?: string;
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

    await this.assertMovable(app, dto.targetClusterId, {
      allowSecretsOf: opts?.allowSecretsOf,
    });

    const bridge = await this.bridge.preflight({
      endpoints: await this.endpointRepo.find({
        where: { applicationId: app.id },
      }),
      sourceClusterId: app.clusterId,
      targetClusterId: dto.targetClusterId,
      requested: dto.bridge !== false,
    });

    const volumePlan = this.volumes.hasVolumes(app)
      ? await this.volumes.plan(
          app,
          userId,
          dto.targetClusterId,
          dto.backupDestinationId,
        )
      : undefined;

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
          bridge: bridge.mode,
          ...(volumePlan
            ? {
                interruption:
                  'The application stops at cutover until its volumes are copied and it is running on the destination.',
              }
            : {}),
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
        bridgeState: {
          mode: bridge.mode,
          skipReason: bridge.skipReason,
          state: null,
          hosts: [],
        },
        provisionOverrides: volumePlan
          ? {
              ...opts?.provisionOverrides,
              volumeDestinationId: volumePlan.destinationId,
              dedicatedNodeName: volumePlan.dedicatedNodeName,
            }
          : opts?.provisionOverrides,
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

  async assertMovable(
    app: ApplicationEntity,
    targetClusterId?: string,
    opts: { allowSecretsOf?: string } = {},
  ): Promise<void> {
    const foreign = [
      ...new Set(
        (app.env ?? [])
          .map((e) => e.externalSecretRef?.secretName)
          .filter((n): n is string => !!n && n !== opts.allowSecretsOf),
      ),
    ];
    if (foreign.length) {
      const one = foreign.length === 1;
      throw new BadRequestException(
        `Application ${app.id} reads variables from ${one ? 'a secret' : 'secrets'} it does not own (${foreign.join(', ')}), which would stay behind on the source cluster. Move the application that owns ${one ? 'it' : 'them'} first.`,
      );
    }

    if (app.pooler?.enabled) {
      throw new BadRequestException(
        `Application ${app.id} is a database with a connection pooler, which moving it as an application would leave behind. Move a database with \`flui migrate db create\`, or together with the app that uses it with \`flui migrate full create\`.`,
      );
    }

    const active = await this.migRepo.findOne({
      where: {
        srcAppId: app.id,
        status: In([
          AppMigrationStatus.PENDING,
          AppMigrationStatus.PROVISIONING,
          AppMigrationStatus.READY,
          AppMigrationStatus.CUTOVER,
          AppMigrationStatus.BRIDGING,
        ]),
      },
    });
    if (active) {
      throw new BadRequestException(
        `Application ${app.id} already has an in-progress migration (${active.id})`,
      );
    }

    // IP-mode (nip.io) endpoints embed the source IP in the fqdn and cannot be
    // moved to a stable hostname — a domain-mode zone is required to migrate.
    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });
    if (endpoints.some((e) => e.hostnameMode === HostnameMode.IP)) {
      throw new BadRequestException(
        `Application ${app.id} has an IP-mode (nip.io) endpoint bound to the source cluster IP — a domain-mode DNS zone is required to migrate`,
      );
    }

    if (endpoints.length) {
      const hosts = [...new Set(endpoints.map((e) => e.fqdn))];
      const sharing = (
        await this.endpointRepo.find({ where: { fqdn: In(hosts) } })
      ).filter((e) => e.applicationId !== app.id);
      if (sharing.length) {
        const other = sharing[0];
        throw new BadRequestException(
          `${other.fqdn} also routes ${other.routePath ?? '/'} to application ${other.applicationId}, which is not moving — its name would follow this one to the destination. Give one of them its own hostname before migrating.`,
        );
      }
    }

    if (targetClusterId) {
      const missing = await this.bridge.zonesMissingOn(
        endpoints,
        targetClusterId,
      );
      if (missing.length) {
        throw new BadRequestException(
          `The destination cluster has no assignment for the DNS zone ${missing.join(', ')}; assign it there first so the name can move with the application.`,
        );
      }
    }
  }

  async cutover(
    id: string,
    fromOrchestrator = false,
  ): Promise<AppMigrationEntity> {
    const mig = await this.findById(id);
    assertNotOrchestrated(mig, fromOrchestrator);
    await this.jobs.queueCutover(id, mig, fromOrchestrator);
    return mig;
  }

  /** A full migration opens the bridge before fencing the source database. */
  async openBridge(
    id: string,
    fromOrchestrator = false,
  ): Promise<AppMigrationEntity> {
    const mig = await this.findById(id);
    assertNotOrchestrated(mig, fromOrchestrator);
    await this.jobs.queueBridgeOpen(id, mig);
    return mig;
  }

  /** Undoes a bridge opened ahead of the promote; refused once the app moved. Idempotent. */
  async rollbackBridge(
    id: string,
    fromOrchestrator = false,
    loaded?: AppMigrationEntity,
  ): Promise<AppMigrationEntity> {
    const mig = loaded ?? (await this.findById(id));
    assertNotOrchestrated(mig, fromOrchestrator);
    if (mig.bridgeState?.state !== 'active') return mig;
    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    if (app?.clusterId === mig.targetClusterId) {
      throw new BadRequestException(
        `Application ${mig.srcAppId} is already served from the destination; the bridge of migration ${id} stays open`,
      );
    }
    await this.legs.rollbackBridge(mig);
    return mig;
  }

  /**
   * After the orchestrator gave up waiting for a bridge to open: undo it once
   * no job holds the leg, so a still-running opening is not raced. Gives up,
   * with a log line, if the leg stays busy.
   */
  async rollbackBridgeWhenIdle(
    id: string,
    timeoutMs = 2 * 60 * 1000,
    pollMs = 2_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await this.jobs.liveJobIds()).has(id)) {
        await this.rollbackBridge(id, true);
        return;
      }
      if (Date.now() >= deadline) {
        this.logger.warn(
          `[app-migration] ${id}: a job still holds the leg, bridge not rolled back`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, pollMs));
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
    assertNotOrchestrated(mig, fromOrchestrator);
    if (mig.bridgeState?.state === 'active' && fromOrchestrator) {
      await this.rollbackBridge(id, true, mig);
    }
    if (mig.bridgeState?.state === 'active') {
      throw new BadRequestException(
        `Migration ${id} already forwards the source to the destination through the bridge — resume the cutover instead of aborting`,
      );
    }
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
    await this.teardown.abort(id, mig, app);
    return mig;
  }

  /**
   * Tear the SOURCE down after the cutover (DESTROY): the
   * bridge first when one is open, then the routes the application left
   * there, then its workload. Never touches the cluster the app is served
   * from. An open bridge closes only once DNS answers cached before the
   * switch have expired, unless the caller says to close it now.
   */
  async destroySource(
    id: string,
    opts: { closeBridge?: boolean } = {},
  ): Promise<AppMigrationEntity> {
    const mig = await this.findById(id);
    if (mig.sourceDestroyedAt) {
      throw new BadRequestException(
        `The source of migration ${id} was already destroyed`,
      );
    }
    const bridging = mig.status === AppMigrationStatus.BRIDGING;
    if (mig.status !== AppMigrationStatus.COMPLETED && !bridging) {
      throw new BadRequestException(
        `Source can only be destroyed after the cutover, in state '${AppMigrationStatus.BRIDGING}' or '${AppMigrationStatus.COMPLETED}' (current: '${mig.status}')`,
      );
    }
    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    if (app?.clusterId !== mig.targetClusterId) {
      throw new BadRequestException(
        `Application ${mig.srcAppId} is not bound to the migration target — refusing to destroy`,
      );
    }

    await this.teardown.destroySource(id, mig, app, bridging, opts);

    mig.sourceDestroyedAt = new Date();
    if (bridging) {
      mig.status = AppMigrationStatus.COMPLETED;
      mig.finishedAt = new Date();
    }
    await this.migRepo.save(mig);
    this.logger.log(
      `[app-migration] ${id}: destroyed the source on cluster ${mig.srcClusterId}`,
    );
    return mig;
  }

  /** `liveJobs` decides whether a CUTOVER row has lost its job; without it such a row is not offered for resume. */
  view(mig: AppMigrationEntity, liveJobs?: Set<string>): AppMigrationView {
    const { bridgeState, ...rest } = mig;
    return {
      ...rest,
      bridge: bridgeView({ bridgeState }, new Date()),
      canResumeCutover: canResumeCutover(mig, liveJobs),
    };
  }

  async getView(id: string): Promise<AppMigrationView> {
    const mig = await this.findById(id);
    return this.view(mig, await this.jobs.liveJobIdsFor([mig]));
  }

  async listViews(userId: string): Promise<AppMigrationView[]> {
    const all = await this.list(userId);
    const live = await this.jobs.liveJobIdsFor(all);
    return all.map((m) => this.view(m, live));
  }

  /**
   * A migration whose job died with the process (a restart, a deploy) stays
   * where it was with nothing driving it. Provisioning and the cutover are
   * both idempotent, so each is queued again at startup when no job holds it:
   * the run for PENDING and PROVISIONING, legs included (their parent only
   * waits for them), the cutover for a standalone CUTOVER.
   */
  async onModuleInit(): Promise<void> {
    await this.jobs.requeueInterrupted();
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
