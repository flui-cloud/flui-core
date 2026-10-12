import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Raw, Repository } from 'typeorm';
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
import { DbReplicationKind } from '../enums/db-replication-status.enum';
import { DbPhysicalReplicationService } from './db-physical-replication.service';
import { DbWriteFenceService } from './db-write-fence.service';
import { DbPodExecService } from './db-pod-exec.service';
import { DbPodPlacementService } from './db-pod-placement.service';
import { DbPoolerCutService } from './db-pooler-cut.service';
import { pausedAndOpen } from '../utils/pooler-cut.core';
import { managementNetworkOn } from '../../infrastructure/networking/management-network.state';
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
    private readonly physical: DbPhysicalReplicationService,
    private readonly fence: DbWriteFenceService,
    private readonly exec: DbPodExecService,
    private readonly placement: DbPodPlacementService,
    private readonly poolerCut?: DbPoolerCutService,
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
    const kind = replicationKindFor(mode, app.clusterId, dto.targetClusterId);
    if (kind === DbReplicationKind.PHYSICAL) {
      await this.placement.assertTargetReady(dto.targetClusterId);
    }

    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.MIGRATE_DATABASE,
        status: OperationStatus.PENDING,
        resourceType: 'db_migration',
        resourceId: dto.srcAppId,
        userId,
        metadata: { targetClusterId: dto.targetClusterId, mode, kind },
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
        kind,
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
    if (mig.kind === DbReplicationKind.PHYSICAL) {
      return this.abortPhysical(mig);
    }
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

  /**
   * Before promote only, and never by promoting the destination. A row is
   * claimed atomically against the cutover: if promote was already asked, the
   * destination is queried first and the abort is refused unless it is still
   * a standby. The source's fence is undone exactly; the destination install
   * is left for inspection.
   */
  private async abortPhysical(
    mig: DbMigrationEntity,
  ): Promise<DbMigrationEntity> {
    const beforeCutover = [
      DbMigrationStatus.PENDING,
      DbMigrationStatus.PROVISIONING,
      DbMigrationStatus.REPLICATING,
      DbMigrationStatus.SYNCED,
      DbMigrationStatus.FAILED,
    ];
    const claimed = await this.migRepo.update(
      [
        { id: mig.id, status: In(beforeCutover) },
        {
          id: mig.id,
          status: DbMigrationStatus.CUTOVER,
          fence: Raw(
            (col) =>
              `(${col} IS NULL OR (${col} ->> 'promoteIssuedAt') IS NULL)`,
          ),
        },
      ] as never,
      { status: DbMigrationStatus.ABORTED },
    );
    if (!claimed.affected) {
      const fresh = await this.findById(mig.id);
      if (fresh.status !== DbMigrationStatus.CUTOVER) {
        throw new BadRequestException(
          `Migration in state '${fresh.status}' cannot be aborted`,
        );
      }
      return this.refuseAfterPromote(fresh);
    }

    const notes: string[] = [];
    if (mig.fence && !mig.fence.releasedAt) {
      const src = await this.exec.resolve(mig.srcAppId);
      mig.fence = await this.fence.unfence(src, mig.fence);
      if (mig.fence.releaseNote) notes.push(mig.fence.releaseNote);
    }
    notes.push(...(await this.teardownLinkOnAbort(mig)));
    const latest = await this.migRepo.findOne({ where: { id: mig.id } });
    if (latest?.fence && !latest.fence.releasedAt && !mig.fence?.releasedAt) {
      const src = await this.exec.resolve(mig.srcAppId);
      mig.fence = await this.fence.unfence(src, latest.fence);
      if (mig.fence.releaseNote) notes.push(mig.fence.releaseNote);
    }
    notes.push(...(await this.resumePoolersOnAbort(mig, latest)));
    mig.status = DbMigrationStatus.ABORTED;
    mig.finishedAt = new Date();
    mig.errorMessage = notes.length ? notes.join('; ') : mig.errorMessage;
    await this.migRepo.save(mig);
    if (mig.infrastructureOperationId) {
      await this.opRepo.update(mig.infrastructureOperationId, {
        status: OperationStatus.CANCELLED,
        completedAt: new Date(),
      });
    }
    this.logger.log(`[db-migration] aborted ${mig.id} (physical)`);
    return mig;
  }

  private async teardownLinkOnAbort(mig: DbMigrationEntity): Promise<string[]> {
    if (!mig.linkId) return [];
    const link = await this.physical.getLink(mig.linkId).catch(() => null);
    if (!link) return [];
    const out = await this.physical.abort(link).catch((err) => ({
      notes: [`link teardown failed: ${err?.message}`],
    }));
    return out.notes;
  }

  private async resumePoolersOnAbort(
    mig: DbMigrationEntity,
    latest: DbMigrationEntity | null,
  ): Promise<string[]> {
    const cut = latest?.poolerCut ?? mig.poolerCut;
    if (!this.poolerCut || !pausedAndOpen(cut)) return [];
    mig.poolerCut = cut;
    return this.poolerCut
      .resumeRoles(mig, ['source', 'destination'], 'abort')
      .catch((err) => [`pooler not resumed: ${err?.message ?? err}`]);
  }

  /**
   * Promote was asked: the cutover keeps asking until the destination is
   * primary, so the migration only goes forward. Abandoning it now could race
   * that retry into two writable copies.
   */
  private async refuseAfterPromote(mig: DbMigrationEntity): Promise<never> {
    const link = mig.linkId
      ? await this.physical.getLink(mig.linkId).catch(() => null)
      : null;
    const state = link ? await this.physical.recoveryState(link) : 'unknown';
    const where = promoteStateText(state);
    throw new BadRequestException(
      `${where}; this migration completes forward and cannot be aborted`,
    );
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

/**
 * A live migration to another cluster replicates physically over a direct
 * Flui-network link; same-cluster, or with the Flui network off, it stays
 * logical. `FLUI_DB_MIGRATION_TRANSPORT=logical` forces the old path.
 */
export function replicationKindFor(
  mode: DbMigrationMode,
  srcClusterId: string,
  targetClusterId: string,
  env: NodeJS.ProcessEnv = process.env,
): DbReplicationKind {
  if (mode !== DbMigrationMode.LIVE) return DbReplicationKind.LOGICAL;
  if (srcClusterId === targetClusterId) return DbReplicationKind.LOGICAL;
  if (env.FLUI_DB_MIGRATION_TRANSPORT?.trim().toLowerCase() === 'logical') {
    return DbReplicationKind.LOGICAL;
  }
  return managementNetworkOn()
    ? DbReplicationKind.PHYSICAL
    : DbReplicationKind.LOGICAL;
}

function promoteStateText(state: string): string {
  if (state === 'primary') return 'The destination is already promoted';
  if (state === 'standby') {
    return 'Promote was asked and is retried until the destination confirms';
  }
  return 'Promote was asked and the destination cannot be queried right now (the source stays fenced)';
}
