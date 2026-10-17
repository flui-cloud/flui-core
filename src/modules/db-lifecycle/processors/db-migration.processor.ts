import { InjectQueue, Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { RestoreJobsService } from '../../backups/services/restore-jobs.service';
import { DbPitrService } from '../../backups/services/db-pitr.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterNodeEntity } from '../../infrastructure/clusters/entities/cluster-node.entity';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import {
  DbCutoverMode,
  DbMigrationMode,
  DbMigrationStatus,
} from '../enums/db-migration.enum';
import { DbReplicationKind } from '../enums/db-replication-status.enum';
import { DbReplicationService } from '../services/db-replication.service';
import { DbPhysicalReplicationService } from '../services/db-physical-replication.service';
import { DbWriteFenceService } from '../services/db-write-fence.service';
import { DbPodPlacementService } from '../services/db-pod-placement.service';
import { DbPodExecService } from '../services/db-pod-exec.service';
import { DbCredentialHandoffService } from '../services/db-credential-handoff.service';
import {
  DB_LIFECYCLE_QUEUE,
  DB_LIFECYCLE_JOB_TYPES,
} from '../db-lifecycle.constants';
import { DbPoolerService } from '../../catalog/services/db-pooler.service';
import { DbPoolerCutService } from '../services/db-pooler-cut.service';
import {
  DbMigrationRunContext,
  DbMigrationState,
  MigrationAbortedError,
} from './db-migration.run-context';
import { DbLogicalMigrationRun } from './db-migration.logical';
import { DbPhysicalCopy } from './db-migration.physical-copy';
import { DbPhysicalCompletion } from './db-migration.physical-complete';
import { DbPhysicalCutover } from './db-migration.physical-cutover';
import { withAdvisoryLock } from '../../common/leadership/advisory-lock';
import {
  HeldRetryData,
  retryHeldDelivery,
} from '../../common/leadership/held-delivery';

interface DbMigrationJobData extends HeldRetryData {
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
  private readonly state: DbMigrationState;
  private readonly logical: DbLogicalMigrationRun;
  private readonly copy: DbPhysicalCopy;
  private readonly completion: DbPhysicalCompletion;
  private readonly cutover: DbPhysicalCutover;

  constructor(
    @InjectRepository(DbMigrationEntity)
    private readonly migRepo: Repository<DbMigrationEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(CatalogInstallEntity)
    installRepo: Repository<CatalogInstallEntity>,
    @InjectRepository(UserEntity)
    userRepo: Repository<UserEntity>,
    installer: CatalogInstallerService,
    repl: DbReplicationService,
    restoreJobs: RestoreJobsService,
    dbPitr: DbPitrService,
    physical: DbPhysicalReplicationService,
    fence: DbWriteFenceService,
    placement: DbPodPlacementService,
    exec: DbPodExecService,
    handoff: DbCredentialHandoffService,
    @InjectRepository(ApplicationEntity)
    appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterNodeEntity)
    nodeRepo: Repository<ClusterNodeEntity>,
    @InjectQueue(DB_LIFECYCLE_QUEUE) queue: Queue,
    poolerCut?: DbPoolerCutService,
    poolers?: DbPoolerService,
  ) {
    const ctx: DbMigrationRunContext = {
      migRepo,
      opRepo,
      installRepo,
      userRepo,
      appRepo,
      nodeRepo,
      installer,
      repl,
      restoreJobs,
      dbPitr,
      physical,
      fence,
      placement,
      exec,
      handoff,
      queue,
      poolerCut,
      poolers,
      logger: this.logger,
      sleep: (ms) => this.sleep(ms),
    };
    this.state = new DbMigrationState(migRepo, opRepo, this.logger);
    this.logical = new DbLogicalMigrationRun(ctx, this.state);
    this.copy = new DbPhysicalCopy(ctx, this.state);
    this.completion = new DbPhysicalCompletion(ctx, this.state);
    this.cutover = new DbPhysicalCutover(ctx, this.state, this.completion);
  }

  @Process(DB_LIFECYCLE_JOB_TYPES.RUN_DB_MIGRATION)
  async run(job: Job<DbMigrationJobData>): Promise<void> {
    const id = job.data.migrationId;
    const outcome = await withAdvisoryLock(
      this.migRepo.manager.connection,
      `db-migration:${id}`,
      () => this.runHeld(id, !!job.data.heldRetries),
    );
    if (!outcome.ran) {
      await retryHeldDelivery(job, this.logger, `[db-migration] ${id} run`);
    }
  }

  private async runHeld(id: string, heldRetry = false): Promise<void> {
    const mig = await this.migRepo.findOne({ where: { id } });
    if (!mig) throw new Error(`Migration ${id} not found`);
    const physical =
      mig.mode === DbMigrationMode.LIVE &&
      mig.kind === DbReplicationKind.PHYSICAL;
    // The logical path starts over from the install, so a retry queued while
    // another worker held the run must not repeat it once that run has begun.
    if (heldRetry && !physical && mig.status !== DbMigrationStatus.PENDING) {
      this.logger.warn(
        `[db-migration] ${mig.id} held retry skipped (state ${mig.status})`,
      );
      return;
    }
    this.logger.log(`[db-migration] Starting ${mig.id} (${mig.mode})`);
    mig.startedAt = new Date();
    await this.migRepo.save(mig);

    if (physical) {
      await this.runPhysical(mig);
      return;
    }

    try {
      await this.logical.run(mig);
    } catch (err: any) {
      await this.state.fail(mig, err);
      throw err;
    }
  }

  @Process(DB_LIFECYCLE_JOB_TYPES.RUN_DB_CUTOVER)
  async runCutover(job: Job<DbMigrationJobData>): Promise<void> {
    const mig = await this.migRepo.findOne({
      where: { id: job.data.migrationId },
    });
    if (!mig) throw new Error(`Migration ${job.data.migrationId} not found`);
    if (mig.kind === DbReplicationKind.PHYSICAL) {
      if (mig.status === DbMigrationStatus.SYNCED) {
        await this.cutover.performPhysicalCutover(mig);
      } else if (mig.status === DbMigrationStatus.CUTOVER) {
        await this.cutover.resolveCutover(mig);
      } else {
        this.logger.warn(
          `[db-migration] cutover job for ${mig.id} skipped (state ${mig.status})`,
        );
      }
      return;
    }
    if (mig.status !== DbMigrationStatus.SYNCED) {
      this.logger.warn(
        `[db-migration] cutover job for ${mig.id} skipped (state ${mig.status})`,
      );
      return;
    }
    try {
      await this.logical.performCutover(mig);
    } catch (err: any) {
      await this.state.fail(mig, err);
      throw err;
    }
  }

  /**
   * Re-entrant: Bull redelivers `run` after an API restart, and each step
   * skips what an earlier delivery already built.
   */
  private async runPhysical(mig: DbMigrationEntity): Promise<void> {
    if (mig.status === DbMigrationStatus.CUTOVER) {
      await this.cutover.resolveCutover(mig);
      return;
    }
    if (mig.status === DbMigrationStatus.SYNCED) {
      if (mig.cutoverMode === DbCutoverMode.AUTO) {
        await this.cutover.performPhysicalCutover(mig);
      }
      return;
    }
    const terminal = [
      DbMigrationStatus.COMPLETED,
      DbMigrationStatus.ABORTED,
      DbMigrationStatus.FAILED,
    ];
    if (terminal.includes(mig.status)) return;

    try {
      await this.copy.provisionStandby(mig);
      const link = await this.copy.buildLink(mig);
      await this.copy.copyAndStream(mig, link);
      if (
        !(await this.state.moveFrom(
          mig,
          [DbMigrationStatus.REPLICATING],
          DbMigrationStatus.SYNCED,
        ))
      ) {
        throw new MigrationAbortedError();
      }
      await this.state.setStep(mig, OperationStep.DB_MIGRATE_SYNCED, 60);
    } catch (err: any) {
      const fresh = await this.migRepo.findOne({ where: { id: mig.id } });
      if (
        err instanceof MigrationAbortedError ||
        fresh?.status === DbMigrationStatus.ABORTED
      ) {
        this.logger.warn(
          `[db-migration] ${mig.id} aborted while running — stopping`,
        );
        return;
      }
      const notes = await this.copy.teardownFailedLink(mig);
      await this.state.fail(
        mig,
        notes.length
          ? new Error(
              `${err?.message ?? err}; cleanup left: ${notes.join('; ')}`,
            )
          : err,
      );
      throw err;
    }

    if (mig.cutoverMode === DbCutoverMode.MANUAL) {
      this.logger.log(
        `[db-migration] ${mig.id} synced (hot standby streaming) — parked awaiting manual cutover`,
      );
      return;
    }
    await this.cutover.performPhysicalCutover(mig);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
