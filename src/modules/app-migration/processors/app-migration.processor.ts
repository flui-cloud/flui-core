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
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import {
  AppVolumeTransferService,
  VolumeTransferPlan,
} from '../services/app-volume-transfer.service';
import {
  AppCutoverMode,
  AppMigrationStatus,
} from '../enums/app-migration.enum';
import {
  APP_MIGRATION_QUEUE,
  APP_MIGRATION_JOB_TYPES,
} from '../app-migration.constants';

interface AppMigrationJobData {
  migrationId: string;
}

/**
 * The application migration machine (plan §6 step 2). Invariants: the source
 * app is never mutated before cutover (rollback = tear the destination workload
 * down, source keeps serving on its cluster); the DNS flip is the traffic point
 * of no return; the app is re-bound to the destination cluster at cutover and
 * the drained source is left running as a proxy window until DESTROY.
 */
@Processor(APP_MIGRATION_QUEUE)
export class AppMigrationProcessor {
  private readonly logger = new Logger(AppMigrationProcessor.name);

  constructor(
    @InjectRepository(AppMigrationEntity)
    private readonly migRepo: Repository<AppMigrationEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    private readonly materializer: ApplicationMaterializerService,
    private readonly endpointReconciliation: AppEndpointReconciliationService,
    private readonly volumes: AppVolumeTransferService,
  ) {}

  @Process(APP_MIGRATION_JOB_TYPES.RUN_APP_MIGRATION)
  async run(job: Job<AppMigrationJobData>): Promise<void> {
    const mig = await this.migRepo.findOne({
      where: { id: job.data.migrationId },
    });
    if (!mig) throw new Error(`Migration ${job.data.migrationId} not found`);
    this.logger.log(`[app-migration] Starting ${mig.id}`);
    mig.startedAt = new Date();
    await this.migRepo.save(mig);

    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    if (!app) {
      await this.fail(mig, new Error(`Application ${mig.srcAppId} not found`));
      return;
    }
    if (app.clusterId === mig.targetClusterId) {
      await this.fail(
        mig,
        new Error(`Application already runs on ${mig.targetClusterId}`),
      );
      return;
    }

    // Provision phase — abortable: any failure tears the destination down and
    // leaves the source untouched (still serving on its cluster).
    try {
      await this.setState(
        mig,
        AppMigrationStatus.PROVISIONING,
        OperationStep.APP_MIGRATE_PROVISION_TARGET,
        15,
      );
      const plan = this.volumePlan(mig);
      await this.materializer.materializeOnCluster(
        app,
        mig.targetClusterId,
        plan
          ? { ...mig.provisionOverrides, replicas: 0 }
          : mig.provisionOverrides,
      );
      if (plan) await this.volumes.warm(app, plan, mig.userId);
    } catch (err: any) {
      await this.teardownDestination(app, mig);
      await this.fail(mig, err);
      throw err;
    }

    // An abort may have landed while materialize was running. Do not promote to
    // READY or cut over — tear the (re-applied) destination down and stop.
    if (await this.isAborted(mig.id)) {
      this.logger.warn(
        `[app-migration] ${mig.id} aborted during provisioning — tearing destination down, not cutting over`,
      );
      await this.teardownDestination(app, mig);
      return;
    }

    await this.setState(
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
      await this.fail(mig, err);
      throw err;
    }
  }

  @Process(APP_MIGRATION_JOB_TYPES.RUN_APP_CUTOVER)
  async runCutover(job: Job<AppMigrationJobData>): Promise<void> {
    const mig = await this.migRepo.findOne({
      where: { id: job.data.migrationId },
    });
    if (!mig) throw new Error(`Migration ${job.data.migrationId} not found`);
    // READY = normal manual cutover; CUTOVER = resume a cutover interrupted
    // mid-flight (performCutover is idempotent).
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
      await this.fail(mig, err);
      throw err;
    }
  }

  /**
   * Flip DNS to the destination, then re-bind the app. The DNS flip is the
   * traffic point of no return; the `clusterId` re-bind is bookkeeping done
   * AFTER it. Idempotent (server-side reconcile + cleared DNS pin), so a
   * partial cutover can be re-run. Endpoint failures are collected, not
   * fail-fast — once the first endpoint has moved, stopping would maximize the
   * split; continuing minimizes it (the same "warn after the point of no
   * return" philosophy as the DB machine's promote).
   */
  private async performCutover(mig: AppMigrationEntity): Promise<void> {
    if (await this.isAborted(mig.id)) {
      this.logger.warn(`[app-migration] ${mig.id} aborted — cutover skipped`);
      return;
    }
    await this.setState(
      mig,
      AppMigrationStatus.CUTOVER,
      OperationStep.APP_MIGRATE_CUTOVER,
      80,
    );

    const app = await this.appRepo.findOne({ where: { id: mig.srcAppId } });
    if (!app) throw new Error(`Application ${mig.srcAppId} not found`);

    const plan = this.volumePlan(mig);
    if (plan && app.clusterId !== mig.targetClusterId) {
      await this.moveVolumes(mig, app, plan);
    }

    const endpoints = await this.endpointRepo.find({
      where: { applicationId: app.id },
    });

    const warnings: string[] = [];
    for (const ep of endpoints) {
      try {
        // Drop the stale DNS pin (a prior reconcile persisted the SOURCE
        // cluster's ingress IP into dnsRecordValue); nulling it makes reconcile
        // fall back to the destination cluster's ingress IP and actually move
        // the A-record. clusterId=B makes reconcile build the Ingress on B.
        ep.dnsRecordValue = null;
        ep.clusterId = mig.targetClusterId;
        await this.endpointRepo.save(ep);
        await this.endpointReconciliation.reconcile(ep.id);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`endpoint ${ep.id}: ${msg}`);
        this.logger.error(
          `[app-migration] ${mig.id}: endpoint ${ep.id} repoint failed: ${msg}`,
        );
      }
    }

    app.clusterId = mig.targetClusterId;
    if (plan?.dedicatedNodeName) app.dedicatedNodeName = plan.dedicatedNodeName;
    await this.appRepo.save(app);

    mig.status = AppMigrationStatus.COMPLETED;
    mig.errorMessage = warnings.length
      ? `cutover completed with warnings: ${warnings.join('; ')}`
      : undefined;
    mig.finishedAt = new Date();
    await this.migRepo.save(mig);
    await this.completeOperation(mig);
    this.logger.log(
      `[app-migration] ${mig.id} COMPLETED: app ${mig.srcAppId} now on ${mig.targetClusterId} (${endpoints.length} endpoint(s) repointed${
        warnings.length ? `, ${warnings.length} with warnings` : ''
      }; source workload left draining)`,
    );
  }

  private volumePlan(mig: AppMigrationEntity): VolumeTransferPlan | undefined {
    const destinationId = mig.provisionOverrides?.volumeDestinationId;
    return destinationId
      ? {
          destinationId,
          dedicatedNodeName: mig.provisionOverrides?.dedicatedNodeName,
        }
      : undefined;
  }

  /**
   * The interruption: the source stops so its volumes stop changing, they are
   * copied, and the destination starts on them. Until DNS moves, every failure
   * gives the source back its copies, so the application never stays down
   * because a move did not finish.
   */
  private async moveVolumes(
    mig: AppMigrationEntity,
    app: ApplicationEntity,
    plan: VolumeTransferPlan,
  ): Promise<void> {
    const replicas = Math.max(1, app.replicas ?? 1);
    const stoppedAt = Date.now();
    try {
      await this.materializer.scaleOnCluster(app, mig.srcClusterId, 0);
      await this.materializer.waitStoppedOnCluster(app, mig.srcClusterId);
      await this.volumes.copy(app, plan, mig.userId, mig.targetClusterId);
      await this.materializer.scaleOnCluster(
        app,
        mig.targetClusterId,
        replicas,
      );
      await this.materializer.waitReadyOnCluster(app, mig.targetClusterId);
    } catch (err) {
      this.logger.error(
        `[app-migration] ${mig.id}: volumes not moved (${(err as Error).message}) — restarting the source`,
      );
      await this.materializer
        .scaleOnCluster(app, mig.targetClusterId, 0)
        .catch(() => undefined);
      await this.materializer
        .scaleOnCluster(app, mig.srcClusterId, replicas)
        .catch((e: unknown) =>
          this.logger.error(
            `[app-migration] ${mig.id}: the source could not be restarted: ${(e as Error).message}`,
          ),
        );
      throw new Error(
        `The volumes could not be moved, so ${app.slug} is running on its original cluster again: ${(err as Error).message}`,
      );
    }
    const seconds = Math.round((Date.now() - stoppedAt) / 1000);
    this.logger.log(
      `[app-migration] ${mig.id}: ${app.slug} was stopped for ${seconds}s while its volumes moved`,
    );
    if (mig.infrastructureOperationId) {
      const op = await this.opRepo.findOne({
        where: { id: mig.infrastructureOperationId },
      });
      if (op) {
        op.metadata = { ...op.metadata, interruptionSeconds: seconds };
        await this.opRepo.save(op);
      }
    }
  }

  private async isAborted(migrationId: string): Promise<boolean> {
    const fresh = await this.migRepo.findOne({ where: { id: migrationId } });
    return fresh?.status === AppMigrationStatus.ABORTED;
  }

  private async teardownDestination(
    app: ApplicationEntity,
    mig: AppMigrationEntity,
  ): Promise<void> {
    await this.materializer
      .teardownOnCluster(app, mig.targetClusterId)
      .catch((e: unknown) =>
        this.logger.warn(
          `[app-migration] ${mig.id}: destination teardown failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
  }

  // --- helpers ---------------------------------------------------------------

  private async setState(
    mig: AppMigrationEntity,
    status: AppMigrationStatus,
    step: OperationStep,
    progress: number,
  ): Promise<void> {
    mig.status = status;
    await this.migRepo.save(mig);
    if (mig.infrastructureOperationId) {
      await this.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.IN_PROGRESS,
        currentStep: step,
        progress,
      });
    }
  }

  private async completeOperation(mig: AppMigrationEntity): Promise<void> {
    if (!mig.infrastructureOperationId) return;
    await this.opRepo.update(mig.infrastructureOperationId, {
      status: OperationStatus.COMPLETED,
      completedAt: new Date(),
      progress: 100,
    });
  }

  private async fail(mig: AppMigrationEntity, err: any): Promise<void> {
    this.logger.error(`[app-migration] ${mig.id} failed: ${err?.message}`);
    mig.status = AppMigrationStatus.FAILED;
    mig.errorMessage = err?.message ?? String(err);
    mig.finishedAt = new Date();
    await this.migRepo.save(mig);
    if (mig.infrastructureOperationId) {
      await this.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.FAILED,
        errorMessage: mig.errorMessage,
        completedAt: new Date(),
      });
    }
  }
}
