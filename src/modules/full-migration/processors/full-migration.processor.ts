import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { DbReplicationService } from '../../db-lifecycle/services/db-replication.service';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  FullCutoverMode,
  FullMigrationStatus,
  RESUMABLE_RUN_STATES,
} from '../enums/full-migration.enum';
import { DbConnectionRewireService } from '../services/db-connection-rewire.service';
import { FullMigrationOpsService } from '../services/full-migration-ops.service';
import { DbPoolerCutService } from '../../db-lifecycle/services/db-pooler-cut.service';
import {
  FULL_MIGRATION_QUEUE,
  FULL_MIGRATION_JOB_TYPES,
} from '../full-migration.constants';
import {
  APP_STAGE_TIMEOUT_MS,
  CHILD_CUTOVER_TIMEOUT_MS,
  PROMOTE_POLL_MS,
  dbReplicateTimeoutMs,
  isPhysical,
  promotedDespiteError,
} from '../utils/full-migration-run.core';
import { FullMigrationLegs } from './full-migration.legs';
import { FullMigrationBridgeFirst } from './full-migration.bridge-first';
import { FullMigrationFinalizer } from './full-migration.finalize';
import { FullMigrationRunContext } from './full-migration.run-context';
import { describeError } from '../../shared/utils/error.util';
import { withAdvisoryLock } from '../../common/leadership/advisory-lock';
import {
  HeldRetryData,
  retryHeldDelivery,
} from '../../common/leadership/held-delivery';

interface FullMigrationJobData extends HeldRetryData {
  migrationId: string;
}

/**
 * Full-app migration orchestrator (MVP-5c). Drives a DbMigration + an
 * AppMigration leg (both MANUAL) and performs the joint cutover. Invariants:
 * no client is wired to the destination DB before promote (app staged at
 * replicas 0); the DB promote is the single joint point of no return; the
 * rewire is persisted AFTER promote; post-PONR is forward-only (FAILED_FORWARD),
 * never unfences the source. Progress/state/wait plumbing lives in
 * FullMigrationOpsService; this owns the state machine.
 */
@Processor(FULL_MIGRATION_QUEUE)
export class FullMigrationProcessor {
  private readonly logger = new Logger(FullMigrationProcessor.name);
  private readonly legs: FullMigrationLegs;
  private readonly bridgeFirst: FullMigrationBridgeFirst;
  private readonly finalizer: FullMigrationFinalizer;

  constructor(
    @InjectRepository(FullMigrationEntity)
    private readonly fmRepo: Repository<FullMigrationEntity>,
    @InjectRepository(DbMigrationEntity)
    private readonly dbMigRepo: Repository<DbMigrationEntity>,
    @InjectRepository(AppMigrationEntity)
    appMigRepo: Repository<AppMigrationEntity>,
    private readonly appsRepo: ApplicationsRepository,
    private readonly dbMig: DbMigrationService,
    repl: DbReplicationService,
    private readonly appMig: AppMigrationService,
    materializer: ApplicationMaterializerService,
    private readonly rewire: DbConnectionRewireService,
    private readonly ops: FullMigrationOpsService,
    poolerCut?: DbPoolerCutService,
  ) {
    const ctx: FullMigrationRunContext = {
      fmRepo,
      dbMigRepo,
      appMigRepo,
      appsRepo,
      dbMig,
      repl,
      appMig,
      materializer,
      rewire,
      ops,
      poolerCut,
      logger: this.logger,
    };
    this.legs = new FullMigrationLegs(ctx);
    this.bridgeFirst = new FullMigrationBridgeFirst(ctx);
    this.finalizer = new FullMigrationFinalizer(ctx);
  }

  @Process(FULL_MIGRATION_JOB_TYPES.RUN_FULL_MIGRATION)
  async run(job: Job<FullMigrationJobData>): Promise<void> {
    const id = job.data.migrationId;
    // Bull hands a job whose lock lapsed to a worker again while the first
    // handler may still be running, here or on another copy: only one drives it.
    const outcome = await withAdvisoryLock(
      this.fmRepo.manager.connection,
      `full-migration:${id}`,
      () => this.runHeld(id),
    );
    if (!outcome.ran) {
      await retryHeldDelivery(job, this.logger, `[full-migration] ${id} run`);
    }
  }

  private async runHeld(id: string): Promise<void> {
    const fm = await this.ops.load(id);
    if (!RESUMABLE_RUN_STATES.includes(fm.status)) {
      this.logger.warn(
        `[full-migration] ${fm.id} run delivery skipped (state ${fm.status})`,
      );
      return;
    }
    await this.drive(fm);
  }

  /**
   * Re-entrant from every pre-cutover state: the legs are found again by id or
   * by their parent, never created twice (a second DB leg would be a second
   * replication slot on the live source).
   */
  private async drive(fm: FullMigrationEntity): Promise<void> {
    if (fm.status === FullMigrationStatus.PENDING) {
      this.logger.log(`[full-migration] Starting ${fm.id}`);
      fm.startedAt = new Date();
      await this.fmRepo.save(fm);
    } else {
      this.logger.warn(
        `[full-migration] ${fm.id} resumed in ${fm.status}, re-attaching to its legs`,
      );
    }

    // Pre-cutover phase — abortable, source untouched.
    try {
      if (
        fm.status === FullMigrationStatus.PENDING ||
        fm.status === FullMigrationStatus.DB_REPLICATING
      ) {
        await this.ops.setState(
          fm,
          FullMigrationStatus.DB_REPLICATING,
          OperationStep.FULL_MIGRATE_DB_REPLICATE,
          10,
        );
        const dbChild = await this.legs.ensureDbLeg(fm);
        await this.ops.waitDb(
          dbChild.id,
          DbMigrationStatus.SYNCED,
          dbReplicateTimeoutMs(dbChild),
        );
        if (await this.legs.stopIfAborted(fm)) return;
      }

      if (fm.status !== FullMigrationStatus.READY) {
        const appChildId = await this.legs.ensureAppLeg(fm);
        await this.ops.waitApp(
          appChildId,
          AppMigrationStatus.READY,
          APP_STAGE_TIMEOUT_MS,
        );
        if (await this.legs.stopIfAborted(fm)) return;

        await this.ops.setState(
          fm,
          FullMigrationStatus.READY,
          OperationStep.FULL_MIGRATE_READY,
          55,
        );
      }
    } catch (err: any) {
      // Pre-cutover failure: tear both legs down (don't leak the source's
      // replication slot / a staged workload) and fail.
      await this.legs.abortChildren(fm);
      await this.ops.fail(fm, err, FullMigrationStatus.FAILED);
      throw err;
    }

    if (fm.cutoverMode === FullCutoverMode.MANUAL) {
      this.logger.log(
        `[full-migration] ${fm.id} ready — parked awaiting manual cutover`,
      );
      return;
    }
    await this.performJointCutover(fm);
  }

  @Process(FULL_MIGRATION_JOB_TYPES.RUN_FULL_CUTOVER)
  async runCutover(job: Job<FullMigrationJobData>): Promise<void> {
    const fm = await this.ops.load(job.data.migrationId);
    // READY = normal; CUTOVER = resume a crashed cutover; FAILED_FORWARD =
    // operator-retried post-PONR resume (all idempotent).
    if (
      fm.status !== FullMigrationStatus.READY &&
      fm.status !== FullMigrationStatus.CUTOVER &&
      fm.status !== FullMigrationStatus.FAILED_FORWARD
    ) {
      this.logger.warn(
        `[full-migration] cutover job for ${fm.id} skipped (state ${fm.status})`,
      );
      return;
    }
    await this.performJointCutover(fm);
  }

  /**
   * The joint cutover. PONR = the DB child's promote (COMPLETED), read from its
   * actual state — never from local control flow — so a parent-side timeout or
   * crash while the child is mid-promote is classified FAILED_FORWARD, not the
   * abortable FAILED. Every post-PONR step is idempotent so the job is
   * re-enterable. The rewire plan is computed + persisted BEFORE the fence, so
   * an attribution failure can never strand a promoted migration.
   */
  private async performJointCutover(fm: FullMigrationEntity): Promise<void> {
    if (!fm.dbMigrationId || !fm.appMigrationId) {
      await this.ops.fail(
        fm,
        new Error('full-migration missing a child leg'),
        FullMigrationStatus.FAILED,
      );
      throw new Error('full-migration missing a child leg');
    }
    if (!(await this.claimCutover(fm))) return;

    const dbChild = await this.dbMigRepo.findOne({
      where: { id: fm.dbMigrationId },
    });
    if (!dbChild) {
      await this.ops.fail(
        fm,
        new Error('DB child migration missing'),
        FullMigrationStatus.FAILED,
      );
      throw new Error('DB child migration missing');
    }

    // PONR = the DB child's promote (COMPLETED). Pre-promote is rollback-able;
    // once promoted, finalize is forward-only + idempotent.
    if (dbChild.status !== DbMigrationStatus.COMPLETED) {
      const forward = await this.bridgeFirst.forwardBeforeBridge(fm, dbChild);
      if (forward === 'failed') return;
      const forwarded = forward === 'forwarded';
      const bridgeOpen = await this.bridgeFirst.openBridgeBeforeFence(
        fm,
        dbChild,
        forwarded,
      );
      await this.promoteDbLeg(fm, dbChild, bridgeOpen, forwarded);
    }
    await this.finalizer.finalizeAppLeg(fm);
  }

  /**
   * Atomically claim the cutover so a racing abort() cannot interleave: exactly
   * one of {this claim → CUTOVER, abort's claim → ABORTED} wins the row. Returns
   * false (caller bails, abort owns the teardown) if the claim was lost.
   */
  private async claimCutover(fm: FullMigrationEntity): Promise<boolean> {
    const claim = await this.fmRepo.update(
      {
        id: fm.id,
        status: In([
          FullMigrationStatus.READY,
          FullMigrationStatus.CUTOVER,
          FullMigrationStatus.FAILED_FORWARD,
        ]),
      },
      { status: FullMigrationStatus.CUTOVER, errorMessage: null as never },
    );
    if (!claim.affected) {
      const fresh = await this.fmRepo.findOne({ where: { id: fm.id } });
      this.logger.warn(
        `[full-migration] ${fm.id} cutover claim lost (state ${fresh?.status}) — abort owns cleanup, skipping`,
      );
      return false;
    }
    fm.status = FullMigrationStatus.CUTOVER;
    fm.errorMessage = undefined;
    await this.ops.setStep(fm, OperationStep.FULL_MIGRATE_DB_CUTOVER, 65);
    return true;
  }

  /**
   * Pre-promote (rollback-able): compute + persist the rewire plan BEFORE the
   * fence (attribution failures must surface here, not after promote), fire the
   * DB child's cutover, and wait for its promote. On failure, classify by the
   * child's ground-truth state — FAILED_FORWARD if it promoted despite our
   * error, otherwise the abortable FAILED.
   */
  private async promoteDbLeg(
    fm: FullMigrationEntity,
    dbChild: DbMigrationEntity,
    bridgeOpen = false,
    forwarded = false,
  ): Promise<void> {
    try {
      if (!fm.rewirePlan?.env) await this.persistRewirePlan(fm, dbChild);
      if (dbChild.status === DbMigrationStatus.SYNCED) {
        await this.dbMig.cutover(dbChild.id, true);
      }
      await this.ops.waitDb(
        dbChild.id,
        DbMigrationStatus.COMPLETED,
        CHILD_CUTOVER_TIMEOUT_MS,
        PROMOTE_POLL_MS,
      );
    } catch (err: any) {
      // Ground truth: did the child promote despite our error?
      const c = await this.dbMigRepo.findOne({ where: { id: dbChild.id } });
      const forward = promotedDespiteError(c);
      // Back to SYNCED or failed, the db leg released the fence and the source
      // is the truth again: send the clients back to it. Still in CUTOVER, it
      // holds the fence and settles by itself; once the promote was asked the
      // bridge is how clients reach the data. Either way the bridge stays.
      if (
        bridgeOpen &&
        !forward &&
        c?.status !== DbMigrationStatus.CUTOVER &&
        fm.appMigrationId
      ) {
        await this.appMig
          .rollbackBridge(fm.appMigrationId, true)
          .catch((e: unknown) =>
            this.logger.error(
              `[full-migration] ${fm.id}: bridge not rolled back: ${describeError(
                e,
              )}`,
            ),
          );
      }
      // Back to the source, the destination pooler stops forwarding to it.
      if (forwarded && !forward && c?.status !== DbMigrationStatus.CUTOVER) {
        await this.bridgeFirst.unforward(fm, dbChild);
      }
      await this.ops.fail(
        fm,
        err,
        forward
          ? FullMigrationStatus.FAILED_FORWARD
          : FullMigrationStatus.FAILED,
      );
      throw err;
    }
  }

  private async persistRewirePlan(
    fm: FullMigrationEntity,
    dbChild: DbMigrationEntity,
  ): Promise<void> {
    const consumer = await this.appsRepo.findById(fm.appId);
    const srcDbApp = await this.appsRepo.findById(fm.dbAppId);
    const dstDbApp = dbChild.dstAppId
      ? await this.appsRepo.findById(dbChild.dstAppId)
      : null;
    if (!consumer || !srcDbApp || !dstDbApp) {
      throw new Error('consumer / source / destination DB app missing');
    }
    fm.rewirePlan = this.rewire.computeRewirePlan(
      consumer,
      srcDbApp,
      dstDbApp,
      {
        ...(isPhysical(dbChild) ? { credentialsFrom: srcDbApp } : {}),
        secretRefs: !!srcDbApp.pooler?.enabled,
      },
    );
    await this.fmRepo.save(fm);
  }
}
