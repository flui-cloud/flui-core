import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { RestoreJobStatus } from '../../backups/enums/restore-job.enum';
import { POOLER_OPTION } from '../../catalog/utils/catalog-options.util';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import {
  DbCutoverMode,
  DbMigrationMode,
  DbMigrationStatus,
} from '../enums/db-migration.enum';
import { DbReplicationStatus } from '../enums/db-replication-status.enum';
import { pauseMs } from '../utils/db-migration-view';
import {
  DRAIN_POLL_INTERVAL_MS,
  DRAIN_TIMEOUT_MS,
  INSTALL_POLL_INTERVAL_MS,
  INSTALL_POLL_TIMEOUT_MS,
  POSTGRESQL_SLUG,
  RESTORE_POLL_INTERVAL_MS,
  RESTORE_TIMEOUT_MS,
  STREAMING_POLL_INTERVAL_MS,
  STREAMING_TIMEOUT_MS,
} from '../utils/db-migration-run.core';
import {
  DbMigrationRunContext,
  DbMigrationState,
} from './db-migration.run-context';

/** The logical-replication and restore paths of the migration machine. */
export class DbLogicalMigrationRun {
  constructor(
    private readonly ctx: DbMigrationRunContext,
    private readonly state: DbMigrationState,
  ) {}

  async run(mig: DbMigrationEntity): Promise<void> {
    if (mig.mode === DbMigrationMode.RESTORE) {
      await this.runRestoreMode(mig);
      return;
    }

    await this.state.setState(
      mig,
      DbMigrationStatus.PROVISIONING,
      OperationStep.DB_MIGRATE_PROVISION_TARGET,
      10,
    );
    // installer.install() persists the email onto the install row, and the
    // owning namespace is derived from it downstream in CatalogInstallProcessor
    // — a queue processor has no request principal to read it off, so it has
    // to be looked up here or the install fails placement.
    const triggeringUser = await this.ctx.userRepo.findOne({
      where: { id: mig.userId },
    });
    const { install } = await this.ctx.installer.install(
      POSTGRESQL_SLUG,
      {
        clusterId: mig.targetClusterId,
        displayName: mig.displayName,
        options: { [POOLER_OPTION]: false },
      },
      mig.userId,
      triggeringUser?.email,
    );
    mig.dstInstallId = install.id;
    await this.ctx.migRepo.save(mig);
    const finalInstall = await this.waitForInstall(install.id);
    if (finalInstall.status !== CatalogInstallStatus.RUNNING) {
      throw new Error(
        `Target install ${install.id} ended in status ${finalInstall.status}`,
      );
    }
    mig.dstAppId = finalInstall.applicationIds?.[0];
    if (!mig.dstAppId) {
      throw new Error(`Target install ${install.id} has no application id`);
    }
    await this.ctx.migRepo.save(mig);

    await this.state.setState(
      mig,
      DbMigrationStatus.REPLICATING,
      OperationStep.DB_MIGRATE_REPLICATE,
      35,
    );
    const link = await this.ctx.repl.replicateTo(
      mig.srcAppId,
      mig.dstAppId,
      'auto',
    );
    mig.linkId = link.id;
    await this.ctx.migRepo.save(mig);
    await this.waitForStreaming(link.id);

    await this.state.setState(
      mig,
      DbMigrationStatus.SYNCED,
      OperationStep.DB_MIGRATE_SYNCED,
      60,
    );
    if (mig.cutoverMode === DbCutoverMode.MANUAL) {
      this.ctx.logger.log(
        `[db-migration] ${mig.id} synced — parked awaiting manual cutover`,
      );
      return;
    }
    await this.performCutover(mig);
  }

  /**
   * The write pause: fence → terminate in-flight writers → drain → verify →
   * promote. Any failure BEFORE promote unfences the source (rollback is
   * trivial there); promote is the point of no return.
   */
  async performCutover(mig: DbMigrationEntity): Promise<void> {
    if (!mig.linkId) throw new Error('Migration has no replication link');
    await this.state.setState(
      mig,
      DbMigrationStatus.CUTOVER,
      OperationStep.DB_MIGRATE_CUTOVER,
      75,
    );

    let fenced = false;
    try {
      await this.ctx.repl.fence(mig.srcAppId);
      fenced = true;
      mig.writesStoppedAt = new Date();
      await this.ctx.repl.terminateWriters(mig.srcAppId);
      await this.waitForDrain(mig.linkId);

      if (mig.verifyRowCounts) {
        const verify = await this.ctx.repl.verifyRowCounts(mig.linkId);
        mig.verifySummary = verify;
        await this.ctx.migRepo.save(mig);
        if (verify.mismatches.length > 0) {
          throw new Error(
            `Row-count mismatch on ${verify.mismatches.length} table(s): ${verify.mismatches.slice(0, 5).join('; ')}`,
          );
        }
      }

      await this.ctx.repl.promote(mig.linkId);
      mig.promoteConfirmedAt = new Date();
      mig.writePauseMs = pauseMs(mig.writesStoppedAt, mig.promoteConfirmedAt);
    } catch (err) {
      if (fenced) {
        await this.ctx.repl
          .unfence(mig.srcAppId)
          .catch((e) =>
            this.ctx.logger.error(
              `[db-migration] ${mig.id}: UNFENCE FAILED after cutover error — source is still read-only: ${e?.message}`,
            ),
          );
      }
      throw err;
    }

    mig.status = DbMigrationStatus.COMPLETED;
    mig.finishedAt = new Date();
    await this.ctx.migRepo.save(mig);
    await this.state.completeOperation(mig);
    this.ctx.logger.log(
      `[db-migration] ${mig.id} COMPLETED: ${mig.srcAppId} → ${mig.dstAppId} (source left fenced)`,
    );
  }

  private async runRestoreMode(mig: DbMigrationEntity): Promise<void> {
    await this.state.setState(
      mig,
      DbMigrationStatus.RESTORING,
      OperationStep.DB_MIGRATE_RESTORE,
      30,
    );
    const restoreJob = await this.ctx.dbPitr.restore(mig.userId, mig.srcAppId, {
      name: mig.displayName,
      clusterId: mig.targetClusterId,
      recoveryTargetTime: mig.recoveryTargetTime?.toISOString(),
    });
    mig.restoreJobId = restoreJob.id;
    await this.ctx.migRepo.save(mig);

    const deadline = Date.now() + RESTORE_TIMEOUT_MS;
    for (;;) {
      const rj = await this.ctx.restoreJobs.findById(restoreJob.id);
      if (rj.status === RestoreJobStatus.COMPLETED) {
        const preview = rj.previewResult as
          | { createdInstallId?: string; createdApplicationIds?: string[] }
          | undefined;
        mig.dstInstallId = preview?.createdInstallId;
        mig.dstAppId = preview?.createdApplicationIds?.[0];
        break;
      }
      if (rj.status === RestoreJobStatus.FAILED) {
        throw new Error(`Restore failed: ${rj.errorMessage ?? 'unknown'}`);
      }
      if (Date.now() > deadline) {
        throw new Error('Restore did not finish in time');
      }
      await new Promise((r) => setTimeout(r, RESTORE_POLL_INTERVAL_MS));
    }

    mig.status = DbMigrationStatus.COMPLETED;
    mig.finishedAt = new Date();
    await this.ctx.migRepo.save(mig);
    await this.state.completeOperation(mig);
    this.ctx.logger.log(
      `[db-migration] ${mig.id} COMPLETED (restore mode): new app ${mig.dstAppId}`,
    );
  }

  private async waitForInstall(
    installId: string,
  ): Promise<CatalogInstallEntity> {
    const deadline = Date.now() + INSTALL_POLL_TIMEOUT_MS;
    for (;;) {
      const install = await this.ctx.installRepo.findOne({
        where: { id: installId },
      });
      if (!install) throw new Error(`Install ${installId} vanished`);
      if (
        install.status === CatalogInstallStatus.RUNNING ||
        install.status === CatalogInstallStatus.FAILED
      ) {
        return install;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Target install ${installId} did not reach a terminal state in time (last=${install.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, INSTALL_POLL_INTERVAL_MS));
    }
  }

  private async waitForStreaming(linkId: string): Promise<void> {
    const deadline = Date.now() + STREAMING_TIMEOUT_MS;
    for (;;) {
      const st = await this.ctx.repl.replicationStatus(linkId);
      if (st.status === DbReplicationStatus.STREAMING) return;
      if (Date.now() > deadline) {
        throw new Error(
          `Replication did not reach streaming in time (state ${st.status}, sub ${st.subscriptionState})`,
        );
      }
      await new Promise((r) => setTimeout(r, STREAMING_POLL_INTERVAL_MS));
    }
  }

  private async waitForDrain(linkId: string): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    for (;;) {
      const st = await this.ctx.repl.replicationStatus(linkId);
      if (st.lagBytes !== null && st.lagBytes <= 0) return;
      if (Date.now() > deadline) {
        throw new Error('Replication did not drain to zero lag during cutover');
      }
      await new Promise((r) => setTimeout(r, DRAIN_POLL_INTERVAL_MS));
    }
  }
}
