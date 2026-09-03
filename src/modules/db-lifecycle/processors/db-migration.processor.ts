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
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { RestoreJobsService } from '../../backups/services/restore-jobs.service';
import { RestoreJobStatus } from '../../backups/enums/restore-job.enum';
import { DbPitrService } from '../../backups/services/db-pitr.service';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import {
  DbCutoverMode,
  DbMigrationMode,
  DbMigrationStatus,
} from '../enums/db-migration.enum';
import { DbReplicationStatus } from '../enums/db-replication-status.enum';
import { DbReplicationService } from '../services/db-replication.service';
import {
  DB_LIFECYCLE_QUEUE,
  DB_LIFECYCLE_JOB_TYPES,
} from '../db-lifecycle.constants';

const POSTGRESQL_SLUG = 'postgresql';
const INSTALL_POLL_INTERVAL_MS = 5_000;
const INSTALL_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const STREAMING_POLL_INTERVAL_MS = 5_000;
const STREAMING_TIMEOUT_MS = 60 * 60 * 1000;
const DRAIN_POLL_INTERVAL_MS = 1_000;
const DRAIN_TIMEOUT_MS = 120 * 1000;
const RESTORE_POLL_INTERVAL_MS = 10_000;
const RESTORE_TIMEOUT_MS = 45 * 60 * 1000;

interface DbMigrationJobData {
  migrationId: string;
}

/**
 * The database migration machine (plan §6, inner core). Invariants: fence
 * strictly precedes promote (at most one writable database at any instant),
 * rollback before promote = unfence + abort link, promote is the point of no
 * return, the source stays fenced forever after cutover.
 */
@Processor(DB_LIFECYCLE_QUEUE)
export class DbMigrationProcessor {
  private readonly logger = new Logger(DbMigrationProcessor.name);

  constructor(
    @InjectRepository(DbMigrationEntity)
    private readonly migRepo: Repository<DbMigrationEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(CatalogInstallEntity)
    private readonly installRepo: Repository<CatalogInstallEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly installer: CatalogInstallerService,
    private readonly repl: DbReplicationService,
    private readonly restoreJobs: RestoreJobsService,
    private readonly dbPitr: DbPitrService,
  ) {}

  @Process(DB_LIFECYCLE_JOB_TYPES.RUN_DB_MIGRATION)
  async run(job: Job<DbMigrationJobData>): Promise<void> {
    const mig = await this.migRepo.findOne({
      where: { id: job.data.migrationId },
    });
    if (!mig) throw new Error(`Migration ${job.data.migrationId} not found`);
    this.logger.log(`[db-migration] Starting ${mig.id} (${mig.mode})`);
    mig.startedAt = new Date();
    await this.migRepo.save(mig);

    try {
      if (mig.mode === DbMigrationMode.RESTORE) {
        await this.runRestoreMode(mig);
        return;
      }

      await this.setState(
        mig,
        DbMigrationStatus.PROVISIONING,
        OperationStep.DB_MIGRATE_PROVISION_TARGET,
        10,
      );
      // installer.install() persists the email onto the install row, and the
      // owning namespace is derived from it downstream in CatalogInstallProcessor
      // — a queue processor has no request principal to read it off, so it has
      // to be looked up here or the install fails placement.
      const triggeringUser = await this.userRepo.findOne({
        where: { id: mig.userId },
      });
      const { install } = await this.installer.install(
        POSTGRESQL_SLUG,
        { clusterId: mig.targetClusterId, displayName: mig.displayName },
        mig.userId,
        triggeringUser?.email,
      );
      mig.dstInstallId = install.id;
      await this.migRepo.save(mig);
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
      await this.migRepo.save(mig);

      await this.setState(
        mig,
        DbMigrationStatus.REPLICATING,
        OperationStep.DB_MIGRATE_REPLICATE,
        35,
      );
      const link = await this.repl.replicateTo(
        mig.srcAppId,
        mig.dstAppId,
        'auto',
      );
      mig.linkId = link.id;
      await this.migRepo.save(mig);
      await this.waitForStreaming(link.id);

      await this.setState(
        mig,
        DbMigrationStatus.SYNCED,
        OperationStep.DB_MIGRATE_SYNCED,
        60,
      );
      if (mig.cutoverMode === DbCutoverMode.MANUAL) {
        this.logger.log(
          `[db-migration] ${mig.id} synced — parked awaiting manual cutover`,
        );
        return;
      }
      await this.performCutover(mig);
    } catch (err: any) {
      await this.fail(mig, err);
      throw err;
    }
  }

  @Process(DB_LIFECYCLE_JOB_TYPES.RUN_DB_CUTOVER)
  async runCutover(job: Job<DbMigrationJobData>): Promise<void> {
    const mig = await this.migRepo.findOne({
      where: { id: job.data.migrationId },
    });
    if (!mig) throw new Error(`Migration ${job.data.migrationId} not found`);
    if (mig.status !== DbMigrationStatus.SYNCED) {
      this.logger.warn(
        `[db-migration] cutover job for ${mig.id} skipped (state ${mig.status})`,
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
   * The write pause: fence → terminate in-flight writers → drain → verify →
   * promote. Any failure BEFORE promote unfences the source (rollback is
   * trivial there); promote is the point of no return.
   */
  private async performCutover(mig: DbMigrationEntity): Promise<void> {
    if (!mig.linkId) throw new Error('Migration has no replication link');
    await this.setState(
      mig,
      DbMigrationStatus.CUTOVER,
      OperationStep.DB_MIGRATE_CUTOVER,
      75,
    );

    let fenced = false;
    try {
      await this.repl.fence(mig.srcAppId);
      fenced = true;
      await this.repl.terminateWriters(mig.srcAppId);
      await this.waitForDrain(mig.linkId);

      if (mig.verifyRowCounts) {
        const verify = await this.repl.verifyRowCounts(mig.linkId);
        mig.verifySummary = verify;
        await this.migRepo.save(mig);
        if (verify.mismatches.length > 0) {
          throw new Error(
            `Row-count mismatch on ${verify.mismatches.length} table(s): ${verify.mismatches.slice(0, 5).join('; ')}`,
          );
        }
      }

      await this.repl.promote(mig.linkId);
    } catch (err) {
      if (fenced) {
        await this.repl
          .unfence(mig.srcAppId)
          .catch((e) =>
            this.logger.error(
              `[db-migration] ${mig.id}: UNFENCE FAILED after cutover error — source is still read-only: ${e?.message}`,
            ),
          );
      }
      throw err;
    }

    mig.status = DbMigrationStatus.COMPLETED;
    mig.finishedAt = new Date();
    await this.migRepo.save(mig);
    await this.completeOperation(mig);
    this.logger.log(
      `[db-migration] ${mig.id} COMPLETED: ${mig.srcAppId} → ${mig.dstAppId} (source left fenced)`,
    );
  }

  private async runRestoreMode(mig: DbMigrationEntity): Promise<void> {
    await this.setState(
      mig,
      DbMigrationStatus.RESTORING,
      OperationStep.DB_MIGRATE_RESTORE,
      30,
    );
    const restoreJob = await this.dbPitr.restore(mig.userId, mig.srcAppId, {
      name: mig.displayName,
      clusterId: mig.targetClusterId,
      recoveryTargetTime: mig.recoveryTargetTime?.toISOString(),
    });
    mig.restoreJobId = restoreJob.id;
    await this.migRepo.save(mig);

    const deadline = Date.now() + RESTORE_TIMEOUT_MS;
    for (;;) {
      const rj = await this.restoreJobs.findById(restoreJob.id);
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
    await this.migRepo.save(mig);
    await this.completeOperation(mig);
    this.logger.log(
      `[db-migration] ${mig.id} COMPLETED (restore mode): new app ${mig.dstAppId}`,
    );
  }

  // --- helpers ---------------------------------------------------------------

  private async setState(
    mig: DbMigrationEntity,
    status: DbMigrationStatus,
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

  private async completeOperation(mig: DbMigrationEntity): Promise<void> {
    if (!mig.infrastructureOperationId) return;
    await this.opRepo.update(mig.infrastructureOperationId, {
      status: OperationStatus.COMPLETED,
      completedAt: new Date(),
      progress: 100,
    });
  }

  private async fail(mig: DbMigrationEntity, err: any): Promise<void> {
    this.logger.error(`[db-migration] ${mig.id} failed: ${err?.message}`);
    mig.status = DbMigrationStatus.FAILED;
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

  private async waitForInstall(
    installId: string,
  ): Promise<CatalogInstallEntity> {
    const deadline = Date.now() + INSTALL_POLL_TIMEOUT_MS;
    for (;;) {
      const install = await this.installRepo.findOne({
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
      const st = await this.repl.replicationStatus(linkId);
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
      const st = await this.repl.replicationStatus(linkId);
      if (st.lagBytes !== null && st.lagBytes <= 0) return;
      if (Date.now() > deadline) {
        throw new Error('Replication did not drain to zero lag during cutover');
      }
      await new Promise((r) => setTimeout(r, DRAIN_POLL_INTERVAL_MS));
    }
  }
}
