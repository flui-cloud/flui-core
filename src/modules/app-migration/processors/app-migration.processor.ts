import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { ClusterDnsZoneEntity } from '../../dns/entities/cluster-dns-zone.entity';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { EndpointBridgeService } from '../../dns/services/endpoint-bridge.service';
import { describeError } from '../../shared/utils/error.util';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import { AppVolumeTransferService } from '../services/app-volume-transfer.service';
import {
  AppCutoverMode,
  AppMigrationStatus,
} from '../enums/app-migration.enum';
import {
  APP_MIGRATION_QUEUE,
  APP_MIGRATION_JOB_TYPES,
} from '../app-migration.constants';
import { bindToTarget, volumePlan } from '../utils/app-migration-plan.core';
import { AppMigrationBridgeLeg } from './app-migration.bridge-leg';
import { AppMigrationRecord } from './app-migration.record';
import { AppMigrationRoutes } from './app-migration.routes';
import { AppMigrationWorkloads } from './app-migration.workloads';

interface AppMigrationJobData {
  migrationId: string;
}

/**
 * The application migration machine (plan §6 step 2). Invariants: the source
 * app is never mutated before cutover (rollback = tear the destination workload
 * down, source keeps serving on its cluster). With the bridge, its activation
 * is the point of no return: from then the source ingress forwards to the
 * destination, the source workload stops and DNS moves while late clients are
 * still served (BRIDGING until DESTROY). Without it, the DNS flip is the point
 * of no return and the drained source keeps running until DESTROY.
 */
@Processor(APP_MIGRATION_QUEUE)
export class AppMigrationProcessor {
  private readonly logger = new Logger(AppMigrationProcessor.name);
  private readonly provisioning = new Set<string>();
  private readonly record: AppMigrationRecord;
  private readonly routes: AppMigrationRoutes;
  private readonly workloads: AppMigrationWorkloads;
  private readonly bridgeLeg: AppMigrationBridgeLeg;

  constructor(
    @InjectRepository(AppMigrationEntity)
    private readonly migRepo: Repository<AppMigrationEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    private readonly materializer: ApplicationMaterializerService,
    endpointReconciliation: AppEndpointReconciliationService,
    private readonly volumes: AppVolumeTransferService,
    @InjectRepository(ClusterDnsZoneEntity)
    zoneRepo: Repository<ClusterDnsZoneEntity>,
    bridge: EndpointBridgeService,
  ) {
    this.record = new AppMigrationRecord(migRepo, opRepo, this.logger);
    this.routes = new AppMigrationRoutes(
      endpointRepo,
      zoneRepo,
      endpointReconciliation,
      this.logger,
      this,
    );
    this.workloads = new AppMigrationWorkloads(
      materializer,
      volumes,
      opRepo,
      this.logger,
    );
    this.bridgeLeg = new AppMigrationBridgeLeg(
      migRepo,
      appRepo,
      endpointRepo,
      materializer,
      endpointReconciliation,
      bridge,
      this.routes,
      this.record,
      this.logger,
      this,
    );
  }

  retryDelayMs = 5_000;
  reconcileAttempts = 24;
  readBackAttempts = 5;
  readBackDelayMs = 3_000;
  cutoverCertificateWaitMs = 60_000;

  @Process(APP_MIGRATION_JOB_TYPES.RUN_APP_MIGRATION)
  async run(job: Job<AppMigrationJobData>): Promise<void> {
    const mig = await this.migRepo.findOne({
      where: { id: job.data.migrationId },
    });
    if (!mig) throw new Error(`Migration ${job.data.migrationId} not found`);
    // A run delivered again (a restart, a lapsed lock) resumes provisioning,
    // which is idempotent; past it, the state belongs to the cutover jobs.
    if (
      mig.status !== AppMigrationStatus.PENDING &&
      mig.status !== AppMigrationStatus.PROVISIONING
    ) {
      this.logger.warn(
        `[app-migration] ${mig.id} run delivery skipped (state ${mig.status})`,
      );
      return;
    }
    if (this.provisioning.has(mig.id)) {
      this.logger.warn(
        `[app-migration] ${mig.id} run delivered again while this process still provisions it — skipped`,
      );
      return;
    }
    this.provisioning.add(mig.id);
    try {
      await this.provision(mig);
    } finally {
      this.provisioning.delete(mig.id);
    }
  }

  private async provision(mig: AppMigrationEntity): Promise<void> {
    this.logger.log(`[app-migration] Starting ${mig.id}`);
    mig.startedAt = new Date();
    await this.migRepo.save(mig);

    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    if (!app) {
      await this.record.fail(
        mig,
        new Error(`Application ${mig.srcAppId} not found`),
      );
      return;
    }
    if (app.clusterId === mig.targetClusterId) {
      await this.record.fail(
        mig,
        new Error(`Application already runs on ${mig.targetClusterId}`),
      );
      return;
    }

    // Provision phase — abortable: any failure tears the destination down and
    // leaves the source untouched (still serving on its cluster).
    try {
      await this.record.setState(
        mig,
        AppMigrationStatus.PROVISIONING,
        OperationStep.APP_MIGRATE_PROVISION_TARGET,
        15,
      );
      const plan = volumePlan(mig);
      await this.materializer.materializeOnCluster(
        app,
        mig.targetClusterId,
        plan
          ? { ...mig.provisionOverrides, replicas: 0 }
          : mig.provisionOverrides,
      );
      if (plan) await this.volumes.warm(app, plan, mig.userId);
    } catch (err: any) {
      await this.workloads.teardownDestination(app, mig);
      await this.record.fail(mig, err);
      throw err;
    }

    // An abort may have landed while materialize was running. Do not promote to
    // READY or cut over — tear the (re-applied) destination down and stop.
    if (await this.record.isAborted(mig.id)) {
      this.logger.warn(
        `[app-migration] ${mig.id} aborted during provisioning — tearing destination down, not cutting over`,
      );
      await this.workloads.teardownDestination(app, mig);
      return;
    }

    await this.prepareBridge(mig, app);
    if (await this.record.isAborted(mig.id)) {
      await this.workloads.teardownDestination(app, mig);
      await this.bridgeLeg.discardPrepared(mig);
      return;
    }

    await this.record.setState(
      mig,
      AppMigrationStatus.READY,
      OperationStep.APP_MIGRATE_READY,
      60,
    );

    if (mig.cutoverMode === AppCutoverMode.MANUAL) {
      this.logger.log(
        `[app-migration] ${mig.id} ready — parked awaiting manual cutover`,
      );
      return;
    }

    try {
      await this.performCutover(mig);
    } catch (err: any) {
      await this.record.fail(mig, err);
      throw err;
    }
  }

  @Process(APP_MIGRATION_JOB_TYPES.RUN_APP_CUTOVER)
  async runCutover(job: Job<AppMigrationJobData>): Promise<void> {
    const mig = await this.migRepo.findOne({
      where: { id: job.data.migrationId },
    });
    if (!mig) throw new Error(`Migration ${job.data.migrationId} not found`);
    // READY = manual cutover; CUTOVER = resume of an interrupted or re-armed
    // cutover (performCutover is idempotent).
    if (
      mig.status !== AppMigrationStatus.READY &&
      mig.status !== AppMigrationStatus.CUTOVER
    ) {
      this.logger.warn(
        `[app-migration] cutover job for ${mig.id} skipped (state ${mig.status})`,
      );
      return;
    }
    try {
      await this.performCutover(mig);
    } catch (err: any) {
      await this.record.fail(mig, err);
      throw err;
    }
  }

  /**
   * A full migration with a live-fenced physical database opens the bridge
   * before fencing the source: the cutover runs up to the activation and the
   * removal of the source route, and stops there. The app stays bound to the
   * source, its pods keep running, DNS does not move; the orchestrator
   * finishes the leg after the promote, or rolls the bridge back.
   */
  @Process(APP_MIGRATION_JOB_TYPES.RUN_APP_BRIDGE_OPEN)
  async runBridgeOpen(job: Job<AppMigrationJobData>): Promise<void> {
    const mig = await this.migRepo.findOne({
      where: { id: job.data.migrationId },
    });
    if (!mig) throw new Error(`Migration ${job.data.migrationId} not found`);
    const resumable =
      mig.status === AppMigrationStatus.READY ||
      (mig.status === AppMigrationStatus.CUTOVER &&
        mig.bridgeState?.state !== 'active');
    if (!resumable || mig.bridgeState?.mode !== 'bridge') {
      this.logger.warn(
        `[app-migration] bridge opening for ${mig.id} skipped (state ${mig.status}, bridge ${mig.bridgeState?.state ?? mig.bridgeState?.mode})`,
      );
      return;
    }
    try {
      await this.performCutover(mig, { stopAfterBridgeOpen: true });
    } catch (err: any) {
      await this.record.fail(mig, err);
      throw err;
    }
  }

  async rollbackBridge(mig: AppMigrationEntity): Promise<void> {
    await this.bridgeLeg.rollback(mig);
  }

  /**
   * With the bridge: the destination route is built while the name stays
   * held where it is, the source ingress starts forwarding (the point of no
   * return), the app is re-bound, the source route and workload stop, and only
   * then DNS moves. Without it, DNS moves and the drained source keeps running
   * until DESTROY. Idempotent, so a partial cutover can be re-run.
   */
  private async performCutover(
    mig: AppMigrationEntity,
    opts: { stopAfterBridgeOpen?: boolean } = {},
  ): Promise<void> {
    if (await this.record.isAborted(mig.id)) {
      this.logger.warn(`[app-migration] ${mig.id} aborted — cutover skipped`);
      return;
    }
    await this.record.setState(
      mig,
      AppMigrationStatus.CUTOVER,
      OperationStep.APP_MIGRATE_CUTOVER,
      80,
    );

    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    if (!app) throw new Error(`Application ${mig.srcAppId} not found`);

    const active = mig.bridgeState?.state === 'active';
    if (!active) await this.routes.assertHostsStillOwn(app);
    const plan = volumePlan(mig);
    let volumesMoved = false;
    if (
      plan &&
      !active &&
      !opts.stopAfterBridgeOpen &&
      app.clusterId !== mig.targetClusterId
    ) {
      await this.workloads.moveVolumes(mig, app, plan);
      volumesMoved = true;
    }

    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });

    if (
      mig.bridgeState?.mode === 'bridge' &&
      (await this.bridgeLeg.cutover(
        mig,
        app,
        endpoints,
        volumesMoved,
        !!opts.stopAfterBridgeOpen,
      ))
    ) {
      return;
    }
    if (opts.stopAfterBridgeOpen) {
      mig.status = AppMigrationStatus.READY;
      await this.migRepo.save(mig);
      return;
    }
    await this.cutoverByDns(mig, app, endpoints);
  }

  /** Cutover without the bridge: DNS moves and the source drains. */
  private async cutoverByDns(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
    endpoints: AppEndpointEntity[],
  ): Promise<void> {
    const warnings: string[] = [];
    const moved: AppEndpointEntity[] = [];
    for (const ep of endpoints) {
      try {
        await this.routes.rebindEndpoints([ep], mig.targetClusterId, null);
        moved.push(ep);
      } catch (e: unknown) {
        warnings.push(`endpoint ${ep.id}: ${describeError(e)}`);
        this.logger.error(
          `[app-migration] ${mig.id}: endpoint ${ep.id} repoint failed: ${describeError(e)}`,
        );
      }
    }
    const flip = await this.routes.flipDns(moved);
    warnings.push(...flip.problems);
    if (moved.length && !flip.problems.length) mig.dnsFlippedAt = new Date();

    bindToTarget(mig, app);
    await this.appRepo.save(app);

    mig.status = AppMigrationStatus.COMPLETED;
    mig.errorMessage = warnings.length
      ? `cutover completed with warnings: ${warnings.join('; ')}`
      : undefined;
    mig.finishedAt = new Date();
    await this.migRepo.save(mig);
    await this.record.completeOperation(mig);
    this.logger.log(
      `[app-migration] ${mig.id} COMPLETED: app ${mig.srcAppId} now on ${mig.targetClusterId} (${endpoints.length} endpoint(s) repointed${
        warnings.length ? `, ${warnings.length} with warnings` : ''
      }; source workload left draining)`,
    );
  }

  private async prepareBridge(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
  ): Promise<void> {
    await this.bridgeLeg.prepare(mig, app);
  }
}
