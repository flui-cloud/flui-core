import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import {
  ApplicationMaterializerService,
  MaterializeOverrides,
} from '../../applications/services/application-materializer.service';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import {
  DbCutoverMode,
  DbMigrationStatus,
} from '../../db-lifecycle/enums/db-migration.enum';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { DbReplicationService } from '../../db-lifecycle/services/db-replication.service';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import {
  AppCutoverMode,
  AppMigrationStatus,
} from '../../app-migration/enums/app-migration.enum';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  FullCutoverMode,
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';
import {
  DbConnectionRewireService,
  RewirePlan,
} from '../services/db-connection-rewire.service';
import { FullMigrationOpsService } from '../services/full-migration-ops.service';
import {
  FULL_MIGRATION_QUEUE,
  FULL_MIGRATION_JOB_TYPES,
} from '../full-migration.constants';

interface FullMigrationJobData {
  migrationId: string;
}

const DB_REPLICATE_TIMEOUT_MS = 75 * 60 * 1000;
const APP_STAGE_TIMEOUT_MS = 15 * 60 * 1000;
const CHILD_CUTOVER_TIMEOUT_MS = 12 * 60 * 1000;

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

  constructor(
    @InjectRepository(FullMigrationEntity)
    private readonly fmRepo: Repository<FullMigrationEntity>,
    @InjectRepository(DbMigrationEntity)
    private readonly dbMigRepo: Repository<DbMigrationEntity>,
    @InjectRepository(AppMigrationEntity)
    private readonly appMigRepo: Repository<AppMigrationEntity>,
    private readonly appsRepo: ApplicationsRepository,
    private readonly dbMig: DbMigrationService,
    private readonly repl: DbReplicationService,
    private readonly appMig: AppMigrationService,
    private readonly materializer: ApplicationMaterializerService,
    private readonly rewire: DbConnectionRewireService,
    private readonly ops: FullMigrationOpsService,
  ) {}

  @Process(FULL_MIGRATION_JOB_TYPES.RUN_FULL_MIGRATION)
  async run(job: Job<FullMigrationJobData>): Promise<void> {
    const fm = await this.ops.load(job.data.migrationId);
    // Re-entry guard: a stalled-job redelivery must never create a second set
    // of children (a second replication slot on the live source).
    if (fm.status !== FullMigrationStatus.PENDING) {
      this.logger.warn(
        `[full-migration] ${fm.id} run re-delivery skipped (state ${fm.status})`,
      );
      return;
    }
    this.logger.log(`[full-migration] Starting ${fm.id}`);
    fm.startedAt = new Date();
    await this.fmRepo.save(fm);

    // Pre-cutover phase — abortable, source untouched.
    try {
      // DB leg → SYNCED (parked, MANUAL)
      await this.ops.setState(
        fm,
        FullMigrationStatus.DB_REPLICATING,
        OperationStep.FULL_MIGRATE_DB_REPLICATE,
        10,
      );
      const dbChild = await this.dbMig.create(
        fm.userId,
        {
          srcAppId: fm.dbAppId,
          targetClusterId: fm.targetClusterId,
          cutover: DbCutoverMode.MANUAL,
        },
        { fullMigrationId: fm.id },
      );
      fm.dbMigrationId = dbChild.id;
      await this.fmRepo.save(fm);
      await this.ops.waitDb(
        dbChild.id,
        DbMigrationStatus.SYNCED,
        DB_REPLICATE_TIMEOUT_MS,
      );
      if (await this.stopIfAborted(fm)) return;

      // Variant B: compute+persist the rewire plan now (dst exists), fence the
      // dst, and stage the app at FULL replicas with the destination env — the
      // apply worker bypasses the fence so replication keeps flowing while the
      // app's own writes fail fast until cutover.
      let provisionOverrides: MaterializeOverrides = { replicas: 0 };
      if (fm.stagingMode === FullStagingMode.LIVE_FENCED) {
        const plan = await this.stageLiveFenced(fm);
        provisionOverrides = { env: plan.env };
        await this.repl.fence(plan.dstAppId);
      }

      // App leg → READY (staged, MANUAL)
      await this.ops.setState(
        fm,
        FullMigrationStatus.APP_STAGING,
        OperationStep.FULL_MIGRATE_APP_STAGE,
        40,
      );
      const appChild = await this.appMig.create(
        fm.userId,
        {
          srcAppId: fm.appId,
          targetClusterId: fm.targetClusterId,
          cutover: AppCutoverMode.MANUAL,
        },
        { fullMigrationId: fm.id, provisionOverrides },
      );
      fm.appMigrationId = appChild.id;
      await this.fmRepo.save(fm);
      await this.ops.waitApp(
        appChild.id,
        AppMigrationStatus.READY,
        APP_STAGE_TIMEOUT_MS,
      );
      if (await this.stopIfAborted(fm)) return;

      await this.ops.setState(
        fm,
        FullMigrationStatus.READY,
        OperationStep.FULL_MIGRATE_READY,
        55,
      );
    } catch (err: any) {
      // Pre-cutover failure: tear both legs down (don't leak the source's
      // replication slot / a staged workload) and fail.
      await this.abortChildren(fm);
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
      await this.promoteDbLeg(fm, dbChild);
    }
    await this.finalizeAppLeg(fm);
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
      { status: FullMigrationStatus.CUTOVER },
    );
    if (!claim.affected) {
      const fresh = await this.fmRepo.findOne({ where: { id: fm.id } });
      this.logger.warn(
        `[full-migration] ${fm.id} cutover claim lost (state ${fresh?.status}) — abort owns cleanup, skipping`,
      );
      return false;
    }
    fm.status = FullMigrationStatus.CUTOVER;
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
  ): Promise<void> {
    try {
      if (!fm.rewirePlan?.env) {
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
        );
        await this.fmRepo.save(fm);
      }
      if (dbChild.status === DbMigrationStatus.SYNCED) {
        await this.dbMig.cutover(dbChild.id, true);
      }
      await this.ops.waitDb(
        dbChild.id,
        DbMigrationStatus.COMPLETED,
        CHILD_CUTOVER_TIMEOUT_MS,
      );
    } catch (err: any) {
      // Ground truth: did the child promote despite our error?
      const c = await this.dbMigRepo.findOne({ where: { id: dbChild.id } });
      const forward =
        !!c &&
        (c.status === DbMigrationStatus.CUTOVER ||
          c.status === DbMigrationStatus.COMPLETED);
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

  /**
   * Post-PONR (forward-only, idempotent): unfence the dst first (variant B) so
   * the staged pods commit without a restart, apply the persisted rewire, re-
   * materialize the consumer, then drive + await the app-leg cutover. Any
   * failure here is FAILED_FORWARD — never abortable.
   */
  private async finalizeAppLeg(fm: FullMigrationEntity): Promise<void> {
    const appMigrationId = fm.appMigrationId;
    try {
      // Variant B: the dst was fenced during staging. Unfence it FIRST (after
      // promote) so the already-running staged pods commit — no restart. Runs
      // whenever the DB leg is promoted; idempotent on an unfenced dst.
      if (fm.stagingMode === FullStagingMode.LIVE_FENCED) {
        const dbc = await this.dbMigRepo.findOne({
          where: { id: fm.dbMigrationId },
        });
        if (dbc?.dstAppId) await this.repl.unfence(dbc.dstAppId);
      }

      await this.ops.setStep(fm, OperationStep.FULL_MIGRATE_REWIRE, 80);
      if (fm.rewirePlan?.env) {
        await this.rewire.applyRewirePlan(fm.appId, fm.rewirePlan);
      }

      await this.ops.setStep(fm, OperationStep.FULL_MIGRATE_APP_START, 88);
      const rewired = await this.appsRepo.findById(fm.appId);
      if (!rewired) throw new Error('consumer application vanished');
      await this.materializer.materializeOnCluster(rewired, fm.targetClusterId);

      await this.ops.setStep(fm, OperationStep.FULL_MIGRATE_DNS_CUTOVER, 94);
      const appChild = await this.appMigRepo.findOne({
        where: { id: appMigrationId },
      });
      // A prior attempt may have left the app-leg FAILED. Its cutover is
      // idempotent post-PONR, so re-arm it to READY and re-drive — otherwise the
      // FAILED_FORWARD resume can never complete (waitApp treats FAILED as
      // terminal and there is no other path to re-drive the leg).
      if (appChild?.status === AppMigrationStatus.FAILED) {
        appChild.status = AppMigrationStatus.READY;
        appChild.errorMessage = undefined;
        await this.appMigRepo.save(appChild);
      }
      if (appChild?.status === AppMigrationStatus.READY) {
        await this.appMig.cutover(appMigrationId, true);
      }
      if (appChild?.status !== AppMigrationStatus.COMPLETED) {
        await this.ops.waitApp(
          appMigrationId,
          AppMigrationStatus.COMPLETED,
          CHILD_CUTOVER_TIMEOUT_MS,
        );
      }

      const finalApp = await this.appMigRepo.findOne({
        where: { id: appMigrationId },
      });
      fm.status = FullMigrationStatus.COMPLETED;
      fm.errorMessage = finalApp?.errorMessage ?? undefined;
      fm.finishedAt = new Date();
      await this.fmRepo.save(fm);
      await this.ops.completeOperation(fm);
      this.logger.log(
        `[full-migration] ${fm.id} COMPLETED: app ${fm.appId} + db on ${fm.targetClusterId}${
          finalApp?.errorMessage
            ? ` (app-leg warnings: ${finalApp.errorMessage})`
            : ''
        }; source app drains, source DB fenced`,
      );
    } catch (err: any) {
      await this.ops.fail(fm, err, FullMigrationStatus.FAILED_FORWARD);
      throw err;
    }
  }

  /** An operator abort may land mid-run; stop (and clean children) if so. */
  private async stopIfAborted(fm: FullMigrationEntity): Promise<boolean> {
    const fresh = await this.fmRepo.findOne({ where: { id: fm.id } });
    if (fresh?.status !== FullMigrationStatus.ABORTED) return false;
    this.logger.warn(
      `[full-migration] ${fm.id} aborted mid-run — stopping and tearing children down`,
    );
    await this.abortChildren(fm);
    return true;
  }

  /**
   * Compute + persist the rewire plan (variant B, at APP_STAGING — the dst
   * already exists) and return its env + the dst app id, so the app can be
   * staged with the destination env against the fenced dst.
   */
  private async stageLiveFenced(
    fm: FullMigrationEntity,
  ): Promise<{ env: RewirePlan['env']; dstAppId: string }> {
    const dbChild = await this.dbMigRepo.findOne({
      where: { id: fm.dbMigrationId },
    });
    if (!dbChild?.dstAppId) {
      throw new Error('destination DB application not provisioned');
    }
    const consumer = await this.appsRepo.findById(fm.appId);
    const srcDbApp = await this.appsRepo.findById(fm.dbAppId);
    const dstDbApp = await this.appsRepo.findById(dbChild.dstAppId);
    if (!consumer || !srcDbApp || !dstDbApp) {
      throw new Error('consumer / source / destination DB app missing');
    }
    fm.rewirePlan = this.rewire.computeRewirePlan(consumer, srcDbApp, dstDbApp);
    await this.fmRepo.save(fm);
    return { env: fm.rewirePlan.env, dstAppId: dbChild.dstAppId };
  }

  /**
   * Best-effort teardown of both child legs (pre-cutover cleanup / abort). For
   * variant B the dst was fenced at staging; unfence it between the app-leg
   * teardown and the db-leg abort (never leave a fenced dst with the src still
   * writable) so the link teardown DDL isn't blocked.
   */
  private async abortChildren(fm: FullMigrationEntity): Promise<void> {
    if (fm.appMigrationId) {
      await this.appMig
        .abort(fm.appMigrationId, true)
        .catch((e: unknown) =>
          this.logger.warn(
            `[full-migration] ${fm.id}: app-leg abort failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          ),
        );
    }
    if (fm.stagingMode === FullStagingMode.LIVE_FENCED && fm.dbMigrationId) {
      const dbChild = await this.dbMigRepo.findOne({
        where: { id: fm.dbMigrationId },
      });
      if (dbChild?.dstAppId) {
        await this.repl
          .unfence(dbChild.dstAppId)
          .catch((e: unknown) =>
            this.logger.warn(
              `[full-migration] ${fm.id}: dst unfence failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
          );
      }
    }
    if (fm.dbMigrationId) {
      await this.dbMig
        .abort(fm.dbMigrationId, true)
        .catch((e: unknown) =>
          this.logger.warn(
            `[full-migration] ${fm.id}: db-leg abort failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          ),
        );
    }
  }
}
