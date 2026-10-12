import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';
import { fullWritePause } from '../utils/full-migration-view';
import {
  CHILD_CUTOVER_TIMEOUT_MS,
  isPhysical,
} from '../utils/full-migration-run.core';
import { FullMigrationRunContext } from './full-migration.run-context';

/** The forward-only half of the joint cutover, once the database leg promoted. */
export class FullMigrationFinalizer {
  constructor(private readonly ctx: FullMigrationRunContext) {}

  /**
   * Post-PONR (forward-only, idempotent): unfence the dst first (variant B) so
   * the staged pods commit without a restart, apply the persisted rewire, re-
   * materialize the consumer, then drive + await the app-leg cutover. Any
   * failure here is FAILED_FORWARD — never abortable.
   */
  async finalizeAppLeg(fm: FullMigrationEntity): Promise<void> {
    const { ctx } = this;
    const appMigrationId = fm.appMigrationId;
    try {
      // Variant B: the dst was fenced during staging. Unfence it FIRST (after
      // promote) so the already-running staged pods commit — no restart. Runs
      // whenever the DB leg is promoted; idempotent on an unfenced dst.
      if (fm.stagingMode === FullStagingMode.LIVE_FENCED) {
        await this.unfenceDestination(fm);
      }

      await ctx.ops.setStep(fm, OperationStep.FULL_MIGRATE_REWIRE, 80);
      const consumer = await ctx.appsRepo.findById(fm.appId);
      if (!consumer) throw new Error('consumer application vanished');
      // The app row takes the rewired env from the app leg, in the same save
      // that moves it to the destination: written here, a redeploy in between
      // would start the source on the destination's database.
      const rewired = fm.rewirePlan?.env
        ? ({ ...consumer, env: fm.rewirePlan.env } as typeof consumer)
        : consumer;

      await ctx.ops.setStep(fm, OperationStep.FULL_MIGRATE_APP_START, 88);
      const appChild = await ctx.appMigRepo.findOne({
        where: { id: appMigrationId },
      });
      // With volumes the app leg's cutover starts the destination itself, once
      // the copy has landed; starting it here would run it on empty volumes.
      const legDone =
        appChild?.status === AppMigrationStatus.COMPLETED ||
        appChild?.status === AppMigrationStatus.BRIDGING;
      const volumesStillToMove =
        !!appChild?.provisionOverrides?.volumeDestinationId && !legDone;
      await this.handRewireToLeg(fm, appChild, legDone);
      // Live-fenced staging already runs the rewired env: re-applying it would
      // only spend the write pause on an apply-and-wait that changes nothing.
      const current =
        !volumesStillToMove &&
        fm.stagingMode === FullStagingMode.LIVE_FENCED &&
        (await this.runsAlready(rewired, fm.targetClusterId));
      if (!current) {
        await ctx.materializer.materializeOnCluster(
          rewired,
          fm.targetClusterId,
          volumesStillToMove ? { replicas: 0 } : undefined,
        );
      }

      await ctx.ops.setStep(fm, OperationStep.FULL_MIGRATE_DNS_CUTOVER, 94);
      // A prior attempt may have left the app-leg FAILED. Its cutover is
      // idempotent post-PONR, so re-arm it to READY and re-drive — otherwise the
      // FAILED_FORWARD resume can never complete (waitApp treats FAILED as
      // terminal and there is no other path to re-drive the leg).
      await this.driveLegCutover(appMigrationId, appChild);
      if (!legDone) {
        await ctx.ops.waitAppAny(
          appMigrationId,
          [AppMigrationStatus.BRIDGING, AppMigrationStatus.COMPLETED],
          CHILD_CUTOVER_TIMEOUT_MS,
        );
      }
      if (fm.rewirePlan?.env) {
        await ctx.rewire.applyRewirePlan(fm.appId, fm.rewirePlan);
      }

      const finalApp = await ctx.appMigRepo.findOne({
        where: { id: appMigrationId },
      });
      const bridging = finalApp?.status === AppMigrationStatus.BRIDGING;
      const dbLeg = await ctx.dbMigRepo.findOne({
        where: { id: fm.dbMigrationId },
      });
      Object.assign(fm, fullWritePause(dbLeg, finalApp));
      fm.status = bridging
        ? FullMigrationStatus.BRIDGING
        : FullMigrationStatus.COMPLETED;
      fm.errorMessage = finalApp?.errorMessage ?? undefined;
      fm.finishedAt = bridging ? undefined : new Date();
      await ctx.fmRepo.save(fm);
      await ctx.ops.completeOperation(fm);
      ctx.logger.log(
        `[full-migration] ${fm.id} ${fm.status.toUpperCase()}: app ${fm.appId} + db on ${fm.targetClusterId}${
          finalApp?.errorMessage
            ? ` (app-leg warnings: ${finalApp.errorMessage})`
            : ''
        }; source app drains, source DB fenced`,
      );
    } catch (err: any) {
      await ctx.ops.fail(fm, err, FullMigrationStatus.FAILED_FORWARD);
      throw err;
    }
  }

  private async unfenceDestination(fm: FullMigrationEntity): Promise<void> {
    const dbc = await this.ctx.dbMigRepo.findOne({
      where: { id: fm.dbMigrationId },
    });
    if (dbc?.dstAppId && !isPhysical(dbc)) {
      await this.ctx.repl.unfence(dbc.dstAppId);
    }
  }

  private async driveLegCutover(
    appMigrationId: string,
    appChild: AppMigrationEntity | null,
  ): Promise<void> {
    if (appChild?.status === AppMigrationStatus.FAILED) {
      appChild.status = AppMigrationStatus.READY;
      appChild.errorMessage = undefined;
      await this.ctx.appMigRepo.save(appChild);
    }
    // CUTOVER: stopped after opening the bridge, or interrupted by a crash;
    // the service does not queue a second cutover while one runs.
    if (
      appChild?.status === AppMigrationStatus.READY ||
      appChild?.status === AppMigrationStatus.CUTOVER
    ) {
      await this.ctx.appMig.cutover(appMigrationId, true);
    }
  }

  private async handRewireToLeg(
    fm: FullMigrationEntity,
    leg: AppMigrationEntity | null,
    legDone: boolean,
  ): Promise<void> {
    if (!leg || legDone || !fm.rewirePlan?.env) return;
    leg.provisionOverrides = {
      ...leg.provisionOverrides,
      env: fm.rewirePlan.env,
    };
    await this.ctx.appMigRepo.save(leg);
  }

  private async runsAlready(
    app: Parameters<ApplicationMaterializerService['isCurrentOnCluster']>[0],
    clusterId: string,
  ): Promise<boolean> {
    try {
      return await this.ctx.materializer.isCurrentOnCluster(app, clusterId);
    } catch {
      return false;
    }
  }
}
