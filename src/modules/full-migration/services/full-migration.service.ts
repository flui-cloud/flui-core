import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  FullCutoverMode,
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';
import { CreateFullMigrationDto } from '../dto/create-full-migration.dto';
import { DbConnectionRewireService } from './db-connection-rewire.service';
import {
  FULL_MIGRATION_QUEUE,
  FULL_MIGRATION_JOB_TYPES,
} from '../full-migration.constants';

@Injectable()
export class FullMigrationService {
  private readonly logger = new Logger(FullMigrationService.name);

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
    private readonly dbMig: DbMigrationService,
    private readonly repl: DbReplicationService,
    private readonly appMig: AppMigrationService,
    private readonly rewire: DbConnectionRewireService,
    @InjectQueue(FULL_MIGRATION_QUEUE) private readonly queue: Queue,
  ) {}

  private static readonly FM_ACTIVE = [
    FullMigrationStatus.PENDING,
    FullMigrationStatus.DB_REPLICATING,
    FullMigrationStatus.APP_STAGING,
    FullMigrationStatus.READY,
    FullMigrationStatus.CUTOVER,
  ];
  private static readonly DB_ACTIVE = [
    DbMigrationStatus.PENDING,
    DbMigrationStatus.PROVISIONING,
    DbMigrationStatus.REPLICATING,
    DbMigrationStatus.SYNCED,
    DbMigrationStatus.CUTOVER,
  ];
  private static readonly APP_ACTIVE = [
    AppMigrationStatus.PENDING,
    AppMigrationStatus.PROVISIONING,
    AppMigrationStatus.READY,
    AppMigrationStatus.CUTOVER,
  ];

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
    // Fail early on the shapes the app leg would reject anyway (before spending
    // a full DB replication). Stateless-only, self-contained.
    if (app.volumes?.length) {
      throw new BadRequestException(
        `Application ${dto.appId} has persistent volumes — v1 full-migration is stateless-only`,
      );
    }
    if (app.persistenceScope === 'dedicated') {
      throw new BadRequestException(
        `Application ${dto.appId} uses dedicated node placement — not supported by v1 full-migration`,
      );
    }
    // Attribution: the consumer must demonstrably point at the source DB.
    this.rewire.assertRewirable(app, dbApp);

    const stagingMode = dto.stagingMode ?? FullStagingMode.SCALED_DOWN;
    if (stagingMode === FullStagingMode.LIVE_FENCED) {
      this.logger.warn(
        `[full-migration] ${dto.appId}: live-fenced staging — a full-replica instance runs against the READ-ONLY destination DB during staging. It MUST boot + pass readiness with no write-migrations-on-start, and MUST NOT run background workers/schedulers with external side-effects (queue consumers, cron, outbound webhooks/email): only its DB writes are fenced (SQLSTATE 25006), external effects are not. Its DB writes fail until cutover.`,
      );
    }

    // No concurrent migration may touch the same consumer OR the same DB — a
    // second replication into a shared DB, or a rival app-migration/redeploy,
    // corrupts the staged/rewired state.
    await this.assertNoConflict(dto.appId, dto.dbAppId);

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

  private async assertNoConflict(
    appId: string,
    dbAppId: string,
  ): Promise<void> {
    const fm = await this.fmRepo.findOne({
      where: [
        { appId, status: In(FullMigrationService.FM_ACTIVE) },
        { dbAppId, status: In(FullMigrationService.FM_ACTIVE) },
      ],
    });
    if (fm) {
      throw new BadRequestException(
        `An in-progress full-migration (${fm.id}) already covers this app or DB`,
      );
    }
    const dbm = await this.dbMigRepo.findOne({
      where: { srcAppId: dbAppId, status: In(FullMigrationService.DB_ACTIVE) },
    });
    if (dbm) {
      throw new BadRequestException(
        `The database ${dbAppId} already has an in-progress migration (${dbm.id})`,
      );
    }
    const appm = await this.appMigRepo.findOne({
      where: { srcAppId: appId, status: In(FullMigrationService.APP_ACTIVE) },
    });
    if (appm) {
      throw new BadRequestException(
        `The application ${appId} already has an in-progress migration (${appm.id})`,
      );
    }
  }

  /** READY = fire cutover; FAILED_FORWARD = retry a post-PONR resume (idempotent). */
  async cutover(id: string): Promise<FullMigrationEntity> {
    const fm = await this.findById(id);
    if (
      fm.status !== FullMigrationStatus.READY &&
      fm.status !== FullMigrationStatus.FAILED_FORWARD
    ) {
      throw new BadRequestException(
        `Cutover is only available in state '${FullMigrationStatus.READY}' or '${FullMigrationStatus.FAILED_FORWARD}' (current: '${fm.status}')`,
      );
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
    const abortable = [
      FullMigrationStatus.PENDING,
      FullMigrationStatus.DB_REPLICATING,
      FullMigrationStatus.APP_STAGING,
      FullMigrationStatus.READY,
      FullMigrationStatus.FAILED,
    ];
    if (!abortable.includes(fm.status)) {
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
      { id, status: In(abortable) },
      { status: FullMigrationStatus.ABORTED, finishedAt: new Date() },
    );
    if (!claimed.affected) {
      const fresh = await this.findById(id);
      throw new BadRequestException(
        `Full-migration ${id} moved to '${fresh.status}' (cutover in progress) — cannot abort`,
      );
    }
    fm.status = FullMigrationStatus.ABORTED;
    if (fm.appMigrationId) {
      await this.appMig
        .abort(fm.appMigrationId, true)
        .catch((e: unknown) => this.warn(id, 'app-leg abort', e));
    }
    // Variant B: unfence the dst (fenced at staging) after the app leg is torn
    // down and before the db leg abort — never leave a fenced dst while the src
    // is still writable, and unblock the link-teardown DDL.
    if (fm.stagingMode === FullStagingMode.LIVE_FENCED && fm.dbMigrationId) {
      const dbChild = await this.dbMigRepo.findOne({
        where: { id: fm.dbMigrationId },
      });
      if (dbChild?.dstAppId) {
        await this.repl
          .unfence(dbChild.dstAppId)
          .catch((e: unknown) => this.warn(id, 'dst unfence', e));
      }
    }
    if (fm.dbMigrationId) {
      await this.dbMig
        .abort(fm.dbMigrationId, true)
        .catch((e: unknown) => this.warn(id, 'db-leg abort', e));
    }
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

  /** After COMPLETED: tear the drained source app workload down (DB stays fenced). */
  async destroySource(id: string): Promise<FullMigrationEntity> {
    const fm = await this.findById(id);
    if (fm.status !== FullMigrationStatus.COMPLETED) {
      throw new BadRequestException(
        `Source can only be destroyed after a COMPLETED full-migration (current: '${fm.status}')`,
      );
    }
    if (!fm.appMigrationId) {
      throw new BadRequestException('Full-migration has no app leg to destroy');
    }
    await this.appMig.destroySource(fm.appMigrationId);
    this.logger.log(`[full-migration] ${id}: source app workload destroyed`);
    return fm;
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
      `[full-migration] ${id}: ${what} failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
