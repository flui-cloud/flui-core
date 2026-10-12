import { AppVolumeTransferService } from '../../app-migration/services/app-volume-transfer.service';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { DbReplicationService } from '../../db-lifecycle/services/db-replication.service';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  FullCutoverMode,
  FullMigrationStatus,
  FullStagingMode,
  RESUMABLE_RUN_STATES,
} from '../enums/full-migration.enum';
import {
  CreateFullMigrationDto,
  FullMigrationCutoverDto,
} from '../dto/create-full-migration.dto';
import { pauseDeadlineMs } from '../../db-lifecycle/utils/pooler-cut.core';
import { DbPoolerCutService } from '../../db-lifecycle/services/db-pooler-cut.service';
import { DbConnectionRewireService } from './db-connection-rewire.service';
import {
  FULL_MIGRATION_QUEUE,
  FULL_MIGRATION_JOB_TYPES,
} from '../full-migration.constants';
import {
  MigrationBridgeView,
  bridgeView,
} from '../../app-migration/utils/bridge-view';
import {
  ABORTABLE,
  canResumeCutover,
  jobMigrationIds,
  needsStartupResume,
  startupResumeJob,
} from '../utils/full-migration-service.core';
import { FullMigrationPreconditions } from './full-migration.preconditions';
import { FullMigrationTeardown } from './full-migration.teardown';
import { describeError } from '../../shared/utils/error.util';

export type FullMigrationView = FullMigrationEntity & {
  bridge: MigrationBridgeView | null;
  canResumeCutover: boolean;
};

@Injectable()
export class FullMigrationService implements OnModuleInit {
  private readonly logger = new Logger(FullMigrationService.name);
  private readonly preconditions: FullMigrationPreconditions;
  private readonly teardown: FullMigrationTeardown;

  constructor(
    @InjectRepository(FullMigrationEntity)
    private readonly fmRepo: Repository<FullMigrationEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(DbMigrationEntity)
    private readonly dbMigRepo: Repository<DbMigrationEntity>,
    @InjectRepository(AppMigrationEntity)
    private readonly appMigRepo: Repository<AppMigrationEntity>,
    private readonly appsRepo: ApplicationsRepository,
    dbMig: DbMigrationService,
    repl: DbReplicationService,
    private readonly appMig: AppMigrationService,
    private readonly volumes: AppVolumeTransferService,
    private readonly rewire: DbConnectionRewireService,
    @InjectQueue(FULL_MIGRATION_QUEUE) private readonly queue: Queue,
    poolerCut?: DbPoolerCutService,
  ) {
    this.preconditions = new FullMigrationPreconditions(
      fmRepo,
      dbMigRepo,
      appMigRepo,
      appsRepo,
      rewire,
    );
    this.teardown = new FullMigrationTeardown(
      dbMigRepo,
      dbMig,
      repl,
      appMig,
      (id, what, e) => this.warn(id, what, e),
      poolerCut,
    );
  }

  async create(
    userId: string,
    dto: CreateFullMigrationDto,
  ): Promise<FullMigrationEntity> {
    const app = await this.appsRepo.findById(dto.appId);
    if (!app) throw new NotFoundException(`Application ${dto.appId} not found`);
    const dbApp = await this.appsRepo.findById(dto.dbAppId);
    if (!dbApp)
      throw new NotFoundException(`DB application ${dto.dbAppId} not found`);
    const cluster = await this.clusterRepo.findOne({
      where: { id: dto.targetClusterId },
    });
    if (!cluster)
      throw new NotFoundException(`Cluster ${dto.targetClusterId} not found`);

    if (app.clusterId === dto.targetClusterId) {
      throw new BadRequestException(
        `Application ${dto.appId} already runs on cluster ${dto.targetClusterId}`,
      );
    }
    if (!dbApp.env?.some((e) => e.name === 'POSTGRES_USER')) {
      throw new BadRequestException(
        `Application ${dto.dbAppId} is not a managed Postgres (no POSTGRES_USER env)`,
      );
    }
    const pooled = !!dbApp.pooler?.enabled;
    const deadlineMs = this.deadline(dto.pauseDeadlineSeconds);
    // Fail early on what the app leg would refuse anyway, before spending a
    // full DB replication: volumes need a destination to move through.
    await this.appMig.assertMovable(app, dto.targetClusterId, {
      allowSecretsOf: pooled ? `${dbApp.slug}-secret` : undefined,
    });
    if (this.volumes.hasVolumes(app)) {
      await this.volumes.plan(
        app,
        userId,
        dto.targetClusterId,
        dto.backupDestinationId,
      );
    }
    // Attribution: the consumer must demonstrably point at the source DB.
    this.rewire.assertRewirable(app, dbApp, { secretRefs: pooled });
    if (pooled) await this.preconditions.assertOnlyConsumer(app, dbApp);

    const stagingMode = dto.stagingMode ?? FullStagingMode.SCALED_DOWN;
    if (stagingMode === FullStagingMode.LIVE_FENCED) {
      this.logger.warn(
        `[full-migration] ${dto.appId}: live-fenced staging — a full-replica instance runs against the READ-ONLY destination DB during staging. It MUST boot + pass readiness with no write-migrations-on-start, and MUST NOT run background workers/schedulers with external side-effects (queue consumers, cron, outbound webhooks/email): only its DB writes are fenced (SQLSTATE 25006), external effects are not. Its DB writes fail until cutover.`,
      );
    }

    // No concurrent migration may touch the same consumer OR the same DB — a
    // second replication into a shared DB, or a rival app-migration/redeploy,
    // corrupts the staged/rewired state.
    await this.preconditions.assertNoConflict(dto.appId, dto.dbAppId);

    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.MIGRATE_FULL_APP,
        status: OperationStatus.PENDING,
        resourceType: 'application',
        resourceName: app.name,
        resourceId: dto.appId,
        userId,
        metadata: {
          dbAppId: dto.dbAppId,
          targetClusterId: dto.targetClusterId,
          ...(pooled ? { pauseDeadlineMs: deadlineMs } : {}),
        },
        totalSteps: 5,
      }),
    );

    const fm = await this.fmRepo.save(
      this.fmRepo.create({
        userId,
        appId: dto.appId,
        dbAppId: dto.dbAppId,
        targetClusterId: dto.targetClusterId,
        cutoverMode: dto.cutover ?? FullCutoverMode.AUTO,
        stagingMode,
        backupDestinationId: dto.backupDestinationId,
        status: FullMigrationStatus.PENDING,
        infrastructureOperationId: op.id,
      }),
    );
    await this.queue.add(FULL_MIGRATION_JOB_TYPES.RUN_FULL_MIGRATION, {
      migrationId: fm.id,
    });
    this.logger.log(
      `[full-migration] ${fm.id}: app ${dto.appId} + db ${dto.dbAppId} → ${dto.targetClusterId} (cutover ${fm.cutoverMode})`,
    );
    return fm;
  }

  private deadline(seconds?: number): number {
    try {
      return pauseDeadlineMs(seconds);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /** READY = fire cutover; FAILED_FORWARD = retry a post-PONR resume (idempotent). */
  async cutover(
    id: string,
    dto: FullMigrationCutoverDto = {},
  ): Promise<FullMigrationEntity> {
    const fm = await this.findById(id);
    const deadlineMs =
      dto.pauseDeadlineSeconds === undefined
        ? null
        : this.deadline(dto.pauseDeadlineSeconds);
    const resumable =
      fm.status === FullMigrationStatus.CUTOVER &&
      !(await this.liveJobIds()).has(id);
    if (
      fm.status !== FullMigrationStatus.READY &&
      fm.status !== FullMigrationStatus.FAILED_FORWARD &&
      !resumable
    ) {
      throw new BadRequestException(
        fm.status === FullMigrationStatus.CUTOVER
          ? `Full-migration ${id} is still cutting over`
          : `Cutover is only available in state '${FullMigrationStatus.READY}' or '${FullMigrationStatus.FAILED_FORWARD}' (current: '${fm.status}')`,
      );
    }
    if (deadlineMs !== null && fm.infrastructureOperationId) {
      const op = await this.opRepo.findOne({
        where: { id: fm.infrastructureOperationId },
      });
      if (op) {
        op.metadata = { ...op.metadata, pauseDeadlineMs: deadlineMs };
        await this.opRepo.save(op);
      }
    }
    await this.queue.add(FULL_MIGRATION_JOB_TYPES.RUN_FULL_CUTOVER, {
      migrationId: id,
    });
    return fm;
  }

  /**
   * Abort pre-cutover: tear both child legs down; nothing on the source moved.
   * Hard-refuses once the DB leg has entered/passed promote — a post-PONR
   * migration must go forward (resume), never be "aborted" into a strand.
   */
  async abort(id: string): Promise<FullMigrationEntity> {
    const fm = await this.findById(id);
    if (!ABORTABLE.includes(fm.status)) {
      throw new BadRequestException(
        `Full-migration in state '${fm.status}' cannot be aborted`,
      );
    }
    if (fm.dbMigrationId) {
      const dbChild = await this.dbMigRepo.findOne({
        where: { id: fm.dbMigrationId },
      });
      if (
        dbChild &&
        (dbChild.status === DbMigrationStatus.CUTOVER ||
          dbChild.status === DbMigrationStatus.COMPLETED)
      ) {
        throw new BadRequestException(
          `Full-migration ${id} has already promoted its database (point of no return) — resume the cutover instead of aborting`,
        );
      }
    }
    // Atomically claim the abort so a racing cutover cannot interleave: exactly
    // one of {this claim → ABORTED, the cutover's claim → CUTOVER} wins the row.
    // Claim BEFORE any teardown so we never tear down a leg a cutover is using.
    const claimed = await this.fmRepo.update(
      { id, status: In(ABORTABLE) },
      { status: FullMigrationStatus.ABORTED, finishedAt: new Date() },
    );
    if (!claimed.affected) {
      const fresh = await this.findById(id);
      throw new BadRequestException(
        `Full-migration ${id} moved to '${fresh.status}' (cutover in progress) — cannot abort`,
      );
    }
    fm.status = FullMigrationStatus.ABORTED;
    await this.teardown.tearDown(id, fm);
    fm.status = FullMigrationStatus.ABORTED;
    fm.finishedAt = new Date();
    await this.fmRepo.save(fm);
    if (fm.infrastructureOperationId) {
      await this.opRepo.update(fm.infrastructureOperationId, {
        status: OperationStatus.CANCELLED,
        completedAt: new Date(),
      });
    }
    this.logger.log(`[full-migration] aborted ${id}`);
    return fm;
  }

  /** After the cutover: close the app leg's bridge and tear the source app workload down (DB stays fenced). */
  async destroySource(
    id: string,
    opts: { closeBridge?: boolean } = {},
  ): Promise<FullMigrationEntity> {
    const fm = await this.findById(id);
    if (
      fm.status !== FullMigrationStatus.COMPLETED &&
      fm.status !== FullMigrationStatus.BRIDGING
    ) {
      throw new BadRequestException(
        `Source can only be destroyed after the cutover, in state '${FullMigrationStatus.BRIDGING}' or '${FullMigrationStatus.COMPLETED}' (current: '${fm.status}')`,
      );
    }
    if (!fm.appMigrationId) {
      throw new BadRequestException('Full-migration has no app leg to destroy');
    }
    await this.appMig.destroySource(fm.appMigrationId, opts);
    if (fm.status === FullMigrationStatus.BRIDGING) {
      fm.status = FullMigrationStatus.COMPLETED;
      fm.finishedAt = new Date();
      await this.fmRepo.save(fm);
    }
    this.logger.log(`[full-migration] ${id}: source app workload destroyed`);
    return fm;
  }

  async getView(id: string): Promise<FullMigrationView> {
    const fm = await this.findById(id);
    const leg = fm.appMigrationId
      ? await this.appMigRepo.findOne({ where: { id: fm.appMigrationId } })
      : null;
    const live = await this.liveJobIdsFor([fm]);
    return {
      ...fm,
      bridge: leg ? bridgeView(leg, new Date()) : null,
      canResumeCutover: canResumeCutover(fm, live),
    };
  }

  async listViews(userId: string): Promise<FullMigrationView[]> {
    const all = await this.list(userId);
    const legIds = all
      .map((fm) => fm.appMigrationId)
      .filter((legId): legId is string => !!legId);
    const legs = legIds.length
      ? await this.appMigRepo.find({ where: { id: In(legIds) } })
      : [];
    const now = new Date();
    const live = await this.liveJobIdsFor(all);
    return all.map((fm) => {
      const leg = legs.find((l) => l.id === fm.appMigrationId);
      return {
        ...fm,
        bridge: leg ? bridgeView(leg, now) : null,
        canResumeCutover: canResumeCutover(fm, live),
      };
    });
  }

  /**
   * A migration whose job died with the process stays where it was with
   * nothing driving it. Both jobs are re-entrant, so each is queued again when
   * no job holds the migration: the run for the pre-cutover states (it
   * re-attaches to the legs it already created), the cutover job for CUTOVER.
   */
  async onModuleInit(): Promise<void> {
    try {
      const candidates = (
        await this.fmRepo.find({
          where: {
            status: In([...RESUMABLE_RUN_STATES, FullMigrationStatus.CUTOVER]),
          },
        })
      ).filter(needsStartupResume);
      if (candidates.length === 0) return;
      const live = await this.liveJobIds();
      for (const fm of candidates) {
        if (live.has(fm.id)) continue;
        const job = startupResumeJob(fm);
        await this.queue.add(
          job.name,
          { migrationId: fm.id },
          { jobId: job.jobId },
        );
        this.logger.warn(
          `[full-migration] ${fm.id}: ${fm.status} found without a job at startup — queued again`,
        );
      }
    } catch (err) {
      this.warn('startup', 'looking for interrupted migrations', err);
    }
  }

  private async liveJobIdsFor(
    all: FullMigrationEntity[],
  ): Promise<Set<string> | undefined> {
    if (!all.some((fm) => fm.status === FullMigrationStatus.CUTOVER)) {
      return new Set();
    }
    return this.liveJobIds().catch(() => undefined);
  }

  private async liveJobIds(): Promise<Set<string>> {
    const jobs = await this.queue.getJobs(['active', 'waiting', 'delayed']);
    return jobMigrationIds(jobs);
  }

  async findById(id: string): Promise<FullMigrationEntity> {
    const fm = await this.fmRepo.findOne({ where: { id } });
    if (!fm) throw new NotFoundException(`Full-migration ${id} not found`);
    return fm;
  }

  async list(userId: string): Promise<FullMigrationEntity[]> {
    return this.fmRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  private warn(id: string, what: string, e: unknown): void {
    this.logger.warn(
      `[full-migration] ${id}: ${what} failed: ${describeError(e)}`,
    );
  }
}
