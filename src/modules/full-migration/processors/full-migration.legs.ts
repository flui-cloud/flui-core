import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { MaterializeOverrides } from '../../applications/services/application-materializer.service';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbCutoverMode } from '../../db-lifecycle/enums/db-migration.enum';
import { AppCutoverMode } from '../../app-migration/enums/app-migration.enum';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';
import { RewirePlan } from '../services/db-connection-rewire.service';
import { isPhysical } from '../utils/full-migration-run.core';
import { FullMigrationRunContext } from './full-migration.run-context';
import { describeError } from '../../shared/utils/error.util';

/** Creates, re-attaches and tears down the two child legs of a full migration. */
export class FullMigrationLegs {
  constructor(private readonly ctx: FullMigrationRunContext) {}

  async ensureDbLeg(fm: FullMigrationEntity): Promise<DbMigrationEntity> {
    const existing = await this.ctx.dbMigRepo.findOne({
      where: fm.dbMigrationId
        ? { id: fm.dbMigrationId }
        : { fullMigrationId: fm.id },
      order: { createdAt: 'DESC' },
    });
    if (existing) {
      if (fm.dbMigrationId !== existing.id) {
        fm.dbMigrationId = existing.id;
        await this.ctx.fmRepo.save(fm);
      }
      return existing;
    }
    const dbChild = await this.ctx.dbMig.create(
      fm.userId,
      {
        srcAppId: fm.dbAppId,
        targetClusterId: fm.targetClusterId,
        cutover: DbCutoverMode.MANUAL,
      },
      { fullMigrationId: fm.id },
    );
    fm.dbMigrationId = dbChild.id;
    await this.ctx.fmRepo.save(fm);
    return dbChild;
  }

  /**
   * Computes and persists the rewire plan now that the destination exists,
   * fences a logical destination, and stages the app at full replicas with the
   * destination env.
   * A leg already created is waited for as it is.
   */
  async ensureAppLeg(fm: FullMigrationEntity): Promise<string> {
    const existing = await this.ctx.appMigRepo.findOne({
      where: fm.appMigrationId
        ? { id: fm.appMigrationId }
        : { fullMigrationId: fm.id },
      order: { createdAt: 'DESC' },
    });
    if (existing) {
      if (fm.appMigrationId !== existing.id) {
        fm.appMigrationId = existing.id;
        await this.ctx.fmRepo.save(fm);
      }
      return existing.id;
    }

    const dbApp = await this.ctx.appsRepo.findById(fm.dbAppId);
    let provisionOverrides: MaterializeOverrides = { replicas: 0 };
    if (fm.stagingMode === FullStagingMode.LIVE_FENCED) {
      const plan = await this.stageLiveFenced(fm);
      provisionOverrides = { env: plan.env };
      if (!plan.physical) await this.ctx.repl.fence(plan.dstAppId);
    }

    await this.ctx.ops.setState(
      fm,
      FullMigrationStatus.APP_STAGING,
      OperationStep.FULL_MIGRATE_APP_STAGE,
      40,
    );
    const appChild = await this.ctx.appMig.create(
      fm.userId,
      {
        srcAppId: fm.appId,
        targetClusterId: fm.targetClusterId,
        cutover: AppCutoverMode.MANUAL,
        backupDestinationId: fm.backupDestinationId,
      },
      {
        fullMigrationId: fm.id,
        provisionOverrides,
        allowSecretsOf: dbApp?.pooler?.enabled
          ? `${dbApp.slug}-secret`
          : undefined,
      },
    );
    fm.appMigrationId = appChild.id;
    await this.ctx.fmRepo.save(fm);
    return appChild.id;
  }

  /**
   * Compute + persist the rewire plan (variant B, at APP_STAGING — the dst
   * already exists) and return its env + the dst app id, so the app can be
   * staged with the destination env against the fenced dst.
   */
  async stageLiveFenced(
    fm: FullMigrationEntity,
  ): Promise<{ env: RewirePlan['env']; dstAppId: string; physical: boolean }> {
    const dbChild = await this.ctx.dbMigRepo.findOne({
      where: { id: fm.dbMigrationId },
    });
    if (!dbChild?.dstAppId) {
      throw new Error('destination DB application not provisioned');
    }
    const consumer = await this.ctx.appsRepo.findById(fm.appId);
    const srcDbApp = await this.ctx.appsRepo.findById(fm.dbAppId);
    const dstDbApp = await this.ctx.appsRepo.findById(dbChild.dstAppId);
    if (!consumer || !srcDbApp || !dstDbApp) {
      throw new Error('consumer / source / destination DB app missing');
    }
    const physical = isPhysical(dbChild);
    fm.rewirePlan = this.ctx.rewire.computeRewirePlan(
      consumer,
      srcDbApp,
      dstDbApp,
      {
        ...(physical ? { credentialsFrom: srcDbApp } : {}),
        secretRefs: !!srcDbApp.pooler?.enabled,
      },
    );
    await this.ctx.fmRepo.save(fm);
    return { env: fm.rewirePlan.env, dstAppId: dbChild.dstAppId, physical };
  }

  /** An operator abort may land mid-run; stop (and clean children) if so. */
  async stopIfAborted(fm: FullMigrationEntity): Promise<boolean> {
    const fresh = await this.ctx.fmRepo.findOne({ where: { id: fm.id } });
    if (fresh?.status !== FullMigrationStatus.ABORTED) return false;
    this.ctx.logger.warn(
      `[full-migration] ${fm.id} aborted mid-run — stopping and tearing children down`,
    );
    await this.abortChildren(fm);
    return true;
  }

  /**
   * Best-effort teardown of both child legs (pre-cutover cleanup / abort). For
   * variant B the dst was fenced at staging; unfence it between the app-leg
   * teardown and the db-leg abort (never leave a fenced dst with the src still
   * writable) so the link teardown DDL isn't blocked.
   */
  async abortChildren(fm: FullMigrationEntity): Promise<void> {
    if (fm.appMigrationId) {
      await this.ctx.appMig
        .abort(fm.appMigrationId, true)
        .catch((e: unknown) =>
          this.ctx.logger.warn(
            `[full-migration] ${fm.id}: app-leg abort failed: ${describeError(
              e,
            )}`,
          ),
        );
    }
    if (fm.stagingMode === FullStagingMode.LIVE_FENCED && fm.dbMigrationId) {
      const dbChild = await this.ctx.dbMigRepo.findOne({
        where: { id: fm.dbMigrationId },
      });
      if (dbChild?.dstAppId && !isPhysical(dbChild)) {
        await this.ctx.repl
          .unfence(dbChild.dstAppId)
          .catch((e: unknown) =>
            this.ctx.logger.warn(
              `[full-migration] ${fm.id}: dst unfence failed: ${describeError(
                e,
              )}`,
            ),
          );
      }
    }
    if (fm.dbMigrationId) {
      await this.ctx.dbMig
        .abort(fm.dbMigrationId, true)
        .catch((e: unknown) =>
          this.ctx.logger.warn(
            `[full-migration] ${fm.id}: db-leg abort failed: ${describeError(
              e,
            )}`,
          ),
        );
    }
  }
}
