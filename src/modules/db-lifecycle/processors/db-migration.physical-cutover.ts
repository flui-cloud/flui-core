import {
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  DbFenceRecord,
  DbMigrationEntity,
  PoolerResumedBy,
} from '../entities/db-migration.entity';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import {
  SlotLostError,
  physicalNames,
} from '../services/db-physical-replication.service';
import { DbPodExecService } from '../services/db-pod-exec.service';
import { DB_LIFECYCLE_JOB_TYPES } from '../db-lifecycle.constants';
import {
  CUTOVER_RETRY_DELAY_MS,
  DRAIN_POLL_INTERVAL_MS,
  DRAIN_TIMEOUT_MS,
  assertSameNodes,
  pooledCut,
} from '../utils/db-migration-run.core';
import {
  DbMigrationRunContext,
  DbMigrationState,
  MigrationAbortedError,
} from './db-migration.run-context';
import { DbPhysicalCompletion } from './db-migration.physical-complete';
import { describeError } from '../../shared/utils/error.util';

type SourcePod = Awaited<ReturnType<DbPodExecService['resolve']>>;

/** The physical write pause, and every way out of CUTOVER. */
export class DbPhysicalCutover {
  constructor(
    private readonly ctx: DbMigrationRunContext,
    private readonly state: DbMigrationState,
    private readonly completion: DbPhysicalCompletion,
  ) {}

  /**
   * The write pause: fence the source, capture its LSN, wait until the
   * destination has replayed it, promote. Any failure before promote is asked
   * unfences the source and returns to SYNCED (replication is intact, a retry
   * is valid). Once promote has been asked, only the destination can say what
   * happened: "unknown" never unfences the source.
   */
  async performPhysicalCutover(mig: DbMigrationEntity): Promise<void> {
    if (!mig.linkId) throw new Error('Migration has no replication link');
    if (
      !(await this.state.moveFrom(
        mig,
        [DbMigrationStatus.SYNCED],
        DbMigrationStatus.CUTOVER,
      ))
    ) {
      this.ctx.logger.warn(
        `[db-migration] ${mig.id}: cutover not started (state changed under it)`,
      );
      return;
    }
    await this.state.setStep(mig, OperationStep.DB_MIGRATE_CUTOVER, 75);
    const link = await this.ctx.physical.getLink(mig.linkId);
    const names = physicalNames(link.id);
    const src = await this.ctx.exec.resolve(mig.srcAppId);
    const pooled = pooledCut(this.ctx.poolerCut, mig);

    let promoteAsked = false;
    try {
      await this.ctx.physical.status(link);
      if ((await this.ctx.physical.recoveryState(link)) !== 'standby') {
        throw new Error('The destination is not a streaming standby');
      }
      await this.assertPodsInPlace(link);
      if (pooled) {
        await this.state.setStep(
          mig,
          OperationStep.DB_MIGRATE_POOLER_PAUSE,
          72,
        );
        await pooled.pause(mig, DRAIN_TIMEOUT_MS, (ms) => this.ctx.sleep(ms));
        await this.state.setStep(mig, OperationStep.DB_MIGRATE_CUTOVER, 75);
      }
      await this.ctx.fence.fence(src, names.fenceMarker, async (record) => {
        mig.fence = record;
        await this.ctx.migRepo.update(mig.id, { fence: record });
      });
      if (pooled) {
        await pooled.settleAfterFence(mig, (ms) => this.ctx.sleep(ms));
      }
      const fenceLsn = await this.ctx.physical.currentLsn(link);
      mig.fence = { ...(mig.fence as DbFenceRecord), fenceLsn };
      await this.ctx.migRepo.update(mig.id, { fence: mig.fence });
      await this.ctx.physical.waitForReplay(link, fenceLsn, {
        timeoutMs: DRAIN_TIMEOUT_MS,
        pollMs: DRAIN_POLL_INTERVAL_MS,
      });
      await this.assertPodsInPlace(link);
      if (!(await this.state.claimPromote(mig))) {
        throw new MigrationAbortedError();
      }
      promoteAsked = true;
      await this.ctx.physical.promote(link);
    } catch (err: any) {
      if (err instanceof MigrationAbortedError) {
        await this.abortCutover(mig, src);
        return;
      }
      if (!promoteAsked) {
        await this.failBeforePromote(mig, src, err);
        return;
      }
      if (!(await this.destinationPromotedDespite(mig, link, err))) return;
    }
    await this.completion.completePhysical(mig, link);
  }

  private async abortCutover(
    mig: DbMigrationEntity,
    src: SourcePod,
  ): Promise<void> {
    this.ctx.logger.warn(
      `[db-migration] ${mig.id}: aborted during cutover — not promoting`,
    );
    await this.releaseFence(mig, src).catch((e) =>
      this.ctx.logger.error(
        `[db-migration] ${mig.id}: UNFENCE FAILED after abort — source still fenced: ${e?.message}`,
      ),
    );
    await this.resumePoolers(mig, 'abort');
  }

  private async failBeforePromote(
    mig: DbMigrationEntity,
    src: SourcePod,
    err: any,
  ): Promise<void> {
    if (!(err instanceof SlotLostError)) {
      await this.rollbackToSynced(mig, err);
      return;
    }
    try {
      await this.releaseFence(mig, src);
    } catch {
      await this.holdCutover(mig, err, 'standby');
      return;
    }
    await this.resumePoolers(mig, 'rollback');
    if (
      await this.state.moveFrom(
        mig,
        [DbMigrationStatus.CUTOVER],
        DbMigrationStatus.FAILED,
      )
    ) {
      await this.state.fail(mig, err);
    }
  }

  /** Promote was asked and something failed: true only when the destination is primary. */
  private async destinationPromotedDespite(
    mig: DbMigrationEntity,
    link: DbReplicationLinkEntity,
    err: any,
  ): Promise<boolean> {
    const state = await this.ctx.physical.recoveryState(link);
    if (state === 'standby') {
      await this.promoteAgain(mig, link);
      return false;
    }
    if (state !== 'primary') {
      await this.holdCutover(mig, err, state);
      return false;
    }
    return true;
  }

  /** CUTOVER found on resume or retry: the destination decides. */
  async resolveCutover(mig: DbMigrationEntity): Promise<void> {
    if (!mig.linkId) throw new Error('Migration has no replication link');
    const link = await this.ctx.physical.getLink(mig.linkId);
    const state = await this.ctx.physical.recoveryState(link);
    if (state === 'primary') {
      await this.completion.completePhysical(mig, link);
      return;
    }
    if (state === 'standby' && !mig.fence?.promoteIssuedAt) {
      await this.rollbackToSynced(
        mig,
        new Error('cutover was interrupted before promote'),
      );
      return;
    }
    if (state === 'standby') {
      await this.promoteAgain(mig, link);
      return;
    }
    await this.holdCutover(
      mig,
      new Error('the destination cannot be queried'),
      state,
    );
  }

  /**
   * Promote was asked and the destination is known to be still a standby:
   * asking again is safe (the source is fenced and stays so), unknown is not.
   */
  private async promoteAgain(
    mig: DbMigrationEntity,
    link: DbReplicationLinkEntity,
  ): Promise<void> {
    try {
      await this.assertPodsInPlace(link);
      await this.ctx.physical.promote(link);
    } catch (err: any) {
      const state = await this.ctx.physical.recoveryState(link);
      if (state !== 'primary') {
        await this.holdCutover(mig, err, state);
        return;
      }
    }
    await this.completion.completePhysical(mig, link);
  }

  private async rollbackToSynced(
    mig: DbMigrationEntity,
    err: any,
  ): Promise<void> {
    const src = await this.ctx.exec.resolve(mig.srcAppId).catch(() => null);
    try {
      if (!src) throw new Error('source unreachable');
      await this.releaseFence(mig, src);
    } catch (unfenceErr: any) {
      this.ctx.logger.error(
        `[db-migration] ${mig.id}: UNFENCE FAILED after cutover error — source stays fenced, retrying: ${unfenceErr?.message}`,
      );
      await this.holdCutover(mig, err, 'standby');
      return;
    }
    const left = await this.resumePoolers(mig, 'rollback');
    const poolerNote = left.length ? `; pooler: ${left.join('; ')}` : '';
    const message = `Cutover failed before promote; the source takes writes again and replication is intact, so cutover can be retried: ${err?.message ?? err}${poolerNote}`;
    if (
      !(await this.state.moveFrom(
        mig,
        [DbMigrationStatus.CUTOVER],
        DbMigrationStatus.SYNCED,
      ))
    ) {
      return;
    }
    mig.errorMessage = message;
    await this.ctx.migRepo.update(mig.id, { errorMessage: message });
    if (mig.infrastructureOperationId) {
      await this.ctx.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.IN_PROGRESS,
        currentStep: OperationStep.DB_MIGRATE_SYNCED,
        progress: 60,
        errorMessage: mig.errorMessage,
      });
    }
    this.ctx.logger.warn(
      `[db-migration] ${mig.id}: back to SYNCED — ${err?.message}`,
    );
  }

  private async holdCutover(
    mig: DbMigrationEntity,
    err: any,
    state: string,
  ): Promise<void> {
    mig.errorMessage = `Promote not confirmed (destination ${state}): ${err?.message ?? err}. The source stays fenced; retrying.`;
    await this.ctx.migRepo.update(mig.id, { errorMessage: mig.errorMessage });
    await this.ctx.queue.add(
      DB_LIFECYCLE_JOB_TYPES.RUN_DB_CUTOVER,
      { migrationId: mig.id },
      { delay: CUTOVER_RETRY_DELAY_MS },
    );
    this.ctx.logger.error(`[db-migration] ${mig.id}: ${mig.errorMessage}`);
  }

  /** Before promote, every pooler the cutover paused lets its clients through again. */
  private async resumePoolers(
    mig: DbMigrationEntity,
    by: PoolerResumedBy,
  ): Promise<string[]> {
    const pooled = pooledCut(this.ctx.poolerCut, mig);
    if (!pooled || !mig.poolerCut?.pausedPods?.length) return [];
    const notes = await pooled
      .resumeRoles(mig, ['source', 'destination'], by)
      .catch((err: unknown) => [describeError(err)]);
    if (notes.length) {
      this.ctx.logger.error(
        `[db-migration] ${mig.id}: pooler not fully resumed: ${notes.join('; ')}`,
      );
    }
    return notes;
  }

  private async releaseFence(
    mig: DbMigrationEntity,
    src: SourcePod,
  ): Promise<void> {
    if (!mig.fence || mig.fence.releasedAt) return;
    mig.fence = await this.ctx.fence.unfence(src, mig.fence);
    await this.ctx.migRepo.update(mig.id, { fence: mig.fence });
  }

  /** The volume is node-local: a Postgres pod that moved is refused, not followed. */
  private async assertPodsInPlace(
    link: DbReplicationLinkEntity,
  ): Promise<void> {
    const src = await this.ctx.placement.nodeOfApp(link.srcAppId);
    const dst = await this.ctx.placement.nodeOfApp(link.dstAppId);
    assertSameNodes(link, src, dst);
  }
}
