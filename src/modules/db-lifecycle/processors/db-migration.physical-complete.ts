import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import { pauseMs } from '../utils/db-migration-view';
import { pooledCut, promoteMeasures } from '../utils/db-migration-run.core';
import {
  DbMigrationRunContext,
  DbMigrationState,
} from './db-migration.run-context';

/** What follows a confirmed promote on the physical path. */
export class DbPhysicalCompletion {
  constructor(
    private readonly ctx: DbMigrationRunContext,
    private readonly state: DbMigrationState,
  ) {}

  /**
   * Forward-only. The credentials, the destination's inherited settings and
   * the source's replication pieces; a failure here is recorded, never undone.
   */
  async completePhysical(
    mig: DbMigrationEntity,
    link: DbReplicationLinkEntity,
  ): Promise<void> {
    await this.recordPromoteConfirmed(mig);
    await this.ctx.physical.markPromoted(link);
    const notes: string[] = [];
    const step = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err: any) {
        notes.push(`${what}: ${err?.message ?? err}`);
      }
    };
    const pooled = pooledCut(this.ctx.poolerCut, mig);
    if (pooled && !mig.poolerCut?.resumedAt) {
      await this.state.setStep(mig, OperationStep.DB_MIGRATE_POOLER_RESUME, 85);
      await step('destination pooler', async () => {
        await pooled.retargetAndResume(mig, (ms) => this.ctx.sleep(ms));
        await this.recordPoolerPause(mig);
      });
    }
    if (pooled) {
      await step('source pooler', () => pooled.suspendSource(mig));
    }
    await step('credentials', () =>
      this.ctx.handoff.adoptSourceCredentials(
        mig.srcAppId,
        mig.dstAppId as string,
      ),
    );
    const poolers = this.ctx.poolers;
    if (poolers && mig.dstAppId) {
      const dstAppId = mig.dstAppId;
      await step('destination pooler role', async () => {
        const { reason } = await poolers.bringUp(dstAppId);
        if (reason) throw new Error(reason);
      });
    }
    await step('destination cleanup', () =>
      this.ctx.physical.finishOnDestination(link),
    );
    await step('source cleanup', () => this.ctx.physical.finishOnSource(link));

    mig.status = DbMigrationStatus.COMPLETED;
    mig.finishedAt = new Date();
    mig.errorMessage = notes.length
      ? `Completed; cleanup left to finish: ${notes.join('; ')}`
      : undefined;
    await this.ctx.migRepo.save(mig);
    await this.state.completeOperation(mig);
    this.ctx.logger.log(
      `[db-migration] ${mig.id} COMPLETED (physical): ${mig.srcAppId} → ${mig.dstAppId} (source left fenced)`,
    );
  }

  /** The first time the destination is seen as primary ends the write pause. */
  private async recordPromoteConfirmed(mig: DbMigrationEntity): Promise<void> {
    if (mig.promoteConfirmedAt) return;
    const measures = promoteMeasures(mig, new Date());
    Object.assign(mig, measures);
    await this.ctx.migRepo.update(mig.id, measures);
  }

  /** With the poolers paused, writes resume when the destination pooler does. */
  private async recordPoolerPause(mig: DbMigrationEntity): Promise<void> {
    const writePauseMs = pauseMs(
      mig.poolerCut?.pausedAt,
      mig.poolerCut?.resumedAt,
    );
    if (writePauseMs === null) return;
    mig.writePauseMs = writePauseMs;
    await this.ctx.migRepo.update(mig.id, { writePauseMs });
  }
}
