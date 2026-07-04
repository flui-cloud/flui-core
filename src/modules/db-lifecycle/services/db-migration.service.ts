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
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import {
  DbCutoverMode,
  DbMigrationMode,
  DbMigrationStatus,
} from '../enums/db-migration.enum';
import { CreateDbMigrationDto } from '../dto/create-db-migration.dto';
import { DbReplicationService } from './db-replication.service';
import {
  DB_LIFECYCLE_QUEUE,
  DB_LIFECYCLE_JOB_TYPES,
} from '../db-lifecycle.constants';

@Injectable()
export class DbMigrationService {
  private readonly logger = new Logger(DbMigrationService.name);

  constructor(
    @InjectRepository(DbMigrationEntity)
    private readonly migRepo: Repository<DbMigrationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectQueue(DB_LIFECYCLE_QUEUE) private readonly queue: Queue,
    private readonly repl: DbReplicationService,
  ) {}

  async create(
    userId: string,
    dto: CreateDbMigrationDto,
    opts?: { fullMigrationId?: string },
  ): Promise<DbMigrationEntity> {
    const app = await this.appRepo.findOne({ where: { id: dto.srcAppId } });
    if (!app) {
      throw new NotFoundException(`Application ${dto.srcAppId} not found`);
    }
    const cluster = await this.clusterRepo.findOne({
      where: { id: dto.targetClusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${dto.targetClusterId} not found`);
    }
    const inFlight = await this.migRepo.findOne({
      where: {
        srcAppId: dto.srcAppId,
        status: In([
          DbMigrationStatus.PENDING,
          DbMigrationStatus.PROVISIONING,
          DbMigrationStatus.REPLICATING,
          DbMigrationStatus.SYNCED,
          DbMigrationStatus.CUTOVER,
        ]),
      },
    });
    if (inFlight) {
      throw new BadRequestException(
        `Database ${dto.srcAppId} already has an in-progress migration (${inFlight.id})`,
      );
    }
    const mode = dto.mode ?? DbMigrationMode.LIVE;

    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.MIGRATE_DATABASE,
        status: OperationStatus.PENDING,
        resourceType: 'db_migration',
        resourceId: dto.srcAppId,
        userId,
        metadata: { targetClusterId: dto.targetClusterId, mode },
        totalSteps: mode === DbMigrationMode.LIVE ? 5 : 3,
      }),
    );

    const mig = await this.migRepo.save(
      this.migRepo.create({
        userId,
        srcAppId: dto.srcAppId,
        targetClusterId: dto.targetClusterId,
        displayName: dto.displayName ?? `${app.slug}-migrated`,
        mode,
        cutoverMode: dto.cutover ?? DbCutoverMode.AUTO,
        verifyRowCounts: dto.verifyRowCounts ?? true,
        recoveryTargetTime: dto.recoveryTargetTime
          ? new Date(dto.recoveryTargetTime)
          : undefined,
        status: DbMigrationStatus.PENDING,
        infrastructureOperationId: op.id,
        fullMigrationId: opts?.fullMigrationId,
      }),
    );
    await this.queue.add(DB_LIFECYCLE_JOB_TYPES.RUN_DB_MIGRATION, {
      migrationId: mig.id,
    });
    this.logger.log(
      `[db-migration] ${mig.id}: ${dto.srcAppId} → cluster ${dto.targetClusterId} (${mode}, cutover ${mig.cutoverMode})`,
    );
    return mig;
  }

  async cutover(
    id: string,
    fromOrchestrator = false,
  ): Promise<DbMigrationEntity> {
    const mig = await this.findById(id);
    this.assertNotOrchestrated(mig, fromOrchestrator);
    if (mig.status !== DbMigrationStatus.SYNCED) {
      throw new BadRequestException(
        `Cutover is only available in state '${DbMigrationStatus.SYNCED}' (current: '${mig.status}')`,
      );
    }
    await this.queue.add(DB_LIFECYCLE_JOB_TYPES.RUN_DB_CUTOVER, {
      migrationId: id,
    });
    return mig;
  }

  private assertNotOrchestrated(
    mig: DbMigrationEntity,
    fromOrchestrator: boolean,
  ): void {
    if (mig.fullMigrationId && !fromOrchestrator) {
      throw new BadRequestException(
        `Migration ${mig.id} is a leg of full-migration ${mig.fullMigrationId} — drive it through the full-migration, not directly`,
      );
    }
  }

  /**
   * Tear the migration down pre-cutover: abort the link (drops sub/slot/pub +
   * the external endpoint). The target install is LEFT for inspection and the
   * fence is never touched here — a failed cutover already unfenced, and an
   * operator-set fence must not be silently undone.
   */
  async abort(
    id: string,
    fromOrchestrator = false,
  ): Promise<DbMigrationEntity> {
    const mig = await this.findById(id);
    this.assertNotOrchestrated(mig, fromOrchestrator);
    const abortable = [
      DbMigrationStatus.PENDING,
      DbMigrationStatus.PROVISIONING,
      DbMigrationStatus.REPLICATING,
      DbMigrationStatus.SYNCED,
      DbMigrationStatus.FAILED,
    ];
    if (!abortable.includes(mig.status)) {
      throw new BadRequestException(
        `Migration in state '${mig.status}' cannot be aborted`,
      );
    }
    if (mig.linkId) {
      await this.repl
        .abort(mig.linkId)
        .catch((err) =>
          this.logger.warn(
            `[db-migration] abort ${id}: link teardown failed: ${err?.message}`,
          ),
        );
    }
    mig.status = DbMigrationStatus.ABORTED;
    mig.finishedAt = new Date();
    await this.migRepo.save(mig);
    if (mig.infrastructureOperationId) {
      await this.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.CANCELLED,
        completedAt: new Date(),
      });
    }
    this.logger.log(`[db-migration] aborted ${id}`);
    return mig;
  }

  async findById(id: string): Promise<DbMigrationEntity> {
    const mig = await this.migRepo.findOne({ where: { id } });
    if (!mig) throw new NotFoundException(`Migration ${id} not found`);
    return mig;
  }

  async list(userId: string): Promise<DbMigrationEntity[]> {
    return this.migRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }
}
