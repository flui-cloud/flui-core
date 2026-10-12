import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  DbMigrationEntity,
  DbPoolerCutRecord,
} from '../../db-lifecycle/entities/db-migration.entity';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import {
  DbPoolerCutService,
  poolerCutApplies,
} from '../../db-lifecycle/services/db-pooler-cut.service';
import { DEFAULT_PAUSE_DEADLINE_MS } from '../../db-lifecycle/utils/pooler-cut.core';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';
import {
  BRIDGE_OPEN_TIMEOUT_MS,
  isPhysical,
} from '../utils/full-migration-run.core';
import { FullMigrationRunContext } from './full-migration.run-context';
import { describeError } from '../../shared/utils/error.util';

/** What happens before the fence: the destination pooler forwards, then the bridge opens. */
export class FullMigrationBridgeFirst {
  constructor(private readonly ctx: FullMigrationRunContext) {}

  /**
   * A pooled source and an app on the pooled address: before the bridge sends
   * clients to the destination, its pooler forwards every session to the
   * source's primary, so writes through the bridge succeed until the cutover
   * pauses them. The plan for that pause is written on the database leg. A
   * forward that cannot be set up is undone and the migration is READY again.
   */
  async forwardBeforeBridge(
    fm: FullMigrationEntity,
    dbChild: DbMigrationEntity,
  ): Promise<'forwarded' | 'skipped' | 'failed'> {
    if (
      dbChild.status === DbMigrationStatus.CUTOVER &&
      dbChild.poolerCut?.poolers?.length
    ) {
      return 'forwarded';
    }
    if (
      dbChild.status !== DbMigrationStatus.SYNCED ||
      !(await this.poolerCutApplies(fm, dbChild))
    ) {
      if (
        dbChild.status === DbMigrationStatus.SYNCED &&
        dbChild.poolerCut?.poolers?.length
      ) {
        await this.ctx.dbMigRepo.update(dbChild.id, { poolerCut: null });
        dbChild.poolerCut = null;
      }
      return 'skipped';
    }
    const cut = this.ctx.poolerCut as DbPoolerCutService;
    const linkId = dbChild.linkId as string;
    try {
      await this.ctx.ops.setStep(
        fm,
        OperationStep.FULL_MIGRATE_POOLER_FORWARD,
        60,
      );
      const source = await cut.forward(linkId);
      const plan: DbPoolerCutRecord = {
        poolers: [
          { appId: fm.dbAppId, role: 'source' },
          { appId: dbChild.dstAppId as string, role: 'destination' },
        ],
        deadlineMs:
          (await this.ctx.ops.pauseDeadlineMs(fm)) ?? DEFAULT_PAUSE_DEADLINE_MS,
        sourceSystemIdentifier: source.systemIdentifier,
        sourceTimeline: source.timeline,
      };
      await this.ctx.dbMigRepo.update(dbChild.id, { poolerCut: plan });
      dbChild.poolerCut = plan;
      await this.ctx.ops.setStep(fm, OperationStep.FULL_MIGRATE_DB_CUTOVER, 65);
      return 'forwarded';
    } catch (err: any) {
      const notes = await cut
        .unforward(linkId)
        .catch((e: unknown) => [describeError(e)]);
      await this.ctx.dbMigRepo.update(dbChild.id, { poolerCut: null });
      dbChild.poolerCut = null;
      const left = notes.length ? `; left: ${notes.join('; ')}` : '';
      fm.errorMessage = `The destination's pooler could not forward to the source, so nothing was cut over and the cutover can be retried: ${err?.message ?? err}${left}`;
      await this.ctx.ops.setState(
        fm,
        FullMigrationStatus.READY,
        OperationStep.FULL_MIGRATE_READY,
        55,
      );
      this.ctx.logger.warn(`[full-migration] ${fm.id}: ${fm.errorMessage}`);
      return 'failed';
    }
  }

  private async poolerCutApplies(
    fm: FullMigrationEntity,
    dbChild: DbMigrationEntity,
  ): Promise<boolean> {
    if (
      !this.ctx.poolerCut ||
      !dbChild.linkId ||
      !dbChild.dstAppId ||
      !fm.rewirePlan?.viaPooler ||
      !(await this.bridgeFirstLeg(fm, dbChild))
    ) {
      return false;
    }
    const src = await this.ctx.appsRepo.findById(fm.dbAppId);
    const dst = await this.ctx.appsRepo.findById(dbChild.dstAppId);
    return poolerCutApplies(src, dst);
  }

  /** The app leg whose bridge opens before the fence, or null when the bridge waits for the promote. */
  private async bridgeFirstLeg(
    fm: FullMigrationEntity,
    dbChild: DbMigrationEntity,
  ): Promise<AppMigrationEntity | null> {
    if (
      !isPhysical(dbChild) ||
      fm.stagingMode !== FullStagingMode.LIVE_FENCED
    ) {
      return null;
    }
    const leg = await this.ctx.appMigRepo.findOne({
      where: { id: fm.appMigrationId },
    });
    if (
      leg?.bridgeState?.mode !== 'bridge' ||
      leg.provisionOverrides?.volumeDestinationId
    ) {
      return null;
    }
    return leg;
  }

  async unforward(
    fm: FullMigrationEntity,
    dbChild: DbMigrationEntity,
  ): Promise<void> {
    if (!this.ctx.poolerCut || !dbChild.linkId) return;
    const notes = await this.ctx.poolerCut
      .unforward(dbChild.linkId)
      .catch((e: unknown) => [describeError(e)]);
    if (notes.length) {
      this.ctx.logger.error(
        `[full-migration] ${fm.id}: destination pooler not fully back on its database: ${notes.join('; ')}`,
      );
    }
  }

  /**
   * Live-fenced over a physical standby: the app on the destination already
   * reads the standby, so the bridge opens before the source is fenced and
   * clients reach the destination from the start; writes then pause only from
   * the fence to the promote. Other paths keep the bridge after the promote.
   * True when the bridge forwards.
   */
  async openBridgeBeforeFence(
    fm: FullMigrationEntity,
    dbChild: DbMigrationEntity,
    forwarded = false,
  ): Promise<boolean> {
    const leg = await this.bridgeFirstLeg(fm, dbChild);
    if (!leg) return false;
    if (leg.bridgeState?.state === 'active') return true;
    // CUTOVER without an active bridge: a crash interrupted the opening.
    if (
      leg.status !== AppMigrationStatus.READY &&
      leg.status !== AppMigrationStatus.CUTOVER
    ) {
      return false;
    }
    try {
      await this.ctx.ops.setStep(
        fm,
        OperationStep.FULL_MIGRATE_BRIDGE_OPEN,
        62,
      );
      await this.ctx.appMig.openBridge(leg.id, true);
      const outcome = await this.ctx.ops.waitAppBridge(
        leg.id,
        BRIDGE_OPEN_TIMEOUT_MS,
      );
      await this.ctx.ops.setStep(fm, OperationStep.FULL_MIGRATE_DB_CUTOVER, 65);
      return outcome === 'active';
    } catch (err: any) {
      await this.ctx.appMig
        .rollbackBridgeWhenIdle(leg.id)
        .catch((e: unknown) =>
          this.ctx.logger.error(
            `[full-migration] ${fm.id}: bridge not rolled back: ${describeError(
              e,
            )}`,
          ),
        );
      if (forwarded) await this.unforward(fm, dbChild);
      await this.ctx.ops.fail(fm, err, FullMigrationStatus.FAILED);
      throw err;
    }
  }
}
