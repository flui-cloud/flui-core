import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import { FullMigrationEntity } from '../../full-migration/entities/full-migration.entity';
import { FullMigrationStatus } from '../../full-migration/enums/full-migration.enum';
import { DbPoolerCutService } from './db-pooler-cut.service';

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** A forward lives from the full migration's claim, while its database leg is still SYNCED, to the promote. */
const FORWARDING = [DbMigrationStatus.SYNCED, DbMigrationStatus.CUTOVER];
/** A full migration in these states may pause and resume its poolers while its database leg still reads SYNCED. */
const CUTTING_OVER = [
  FullMigrationStatus.CUTOVER,
  FullMigrationStatus.BRIDGING,
];

/**
 * A paused PgBouncer has no timer of its own. A pooler a migration paused or
 * left forwarding, whose migration is no longer cutting over and which is not
 * the source left suspended for good, is put back to serving. Only poolers a
 * recent migration touched are looked at.
 */
@Injectable()
export class PoolerPauseSweeper {
  private readonly logger = new Logger(PoolerPauseSweeper.name);
  private running = false;

  constructor(
    @InjectRepository(DbMigrationEntity)
    private readonly migRepo: Repository<DbMigrationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    private readonly poolerCut: DbPoolerCutService,
    @InjectRepository(FullMigrationEntity)
    private readonly fullRepo: Repository<FullMigrationEntity>,
  ) {}

  @Cron(process.env.POOLER_PAUSE_SWEEP_CRON || CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(
        `[pooler-sweep] cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async sweep(now = new Date()): Promise<string[]> {
    const recent = await this.migRepo.find({
      where: {
        poolerCut: Not(IsNull()),
        updatedAt: MoreThan(new Date(now.getTime() - LOOKBACK_MS)),
      },
    });
    const appIds = [
      ...new Set(
        recent.flatMap((m) => (m.poolerCut?.poolers ?? []).map((p) => p.appId)),
      ),
    ];
    if (!appIds.length) return [];
    const busy = await this.migRepo.find({
      where: [
        { srcAppId: In(appIds), status: In(FORWARDING) },
        { dstAppId: In(appIds), status: In(FORWARDING) },
      ],
    });
    const ids = (status: DbMigrationStatus[]) =>
      new Set(
        busy
          .filter((m) => status.includes(m.status))
          .flatMap((m) => [m.srcAppId, m.dstAppId]),
      );
    const mayForward = ids(FORWARDING);
    const mayPause = ids([DbMigrationStatus.CUTOVER]);
    for (const id of await this.legsOfCuttingOverParents(busy)) {
      mayPause.add(id);
    }
    const released: string[] = [];
    for (const app of await this.apps.find({ where: { id: In(appIds) } })) {
      const spec = app.pooler;
      if (!spec?.enabled || spec.suspended || mayPause.has(app.id)) continue;
      if (await this.releaseStray(app, spec, mayForward)) {
        released.push(app.id);
      }
    }
    return released;
  }

  private async releaseStray(
    app: ApplicationEntity,
    spec: NonNullable<ApplicationEntity['pooler']>,
    mayForward: Set<string>,
  ): Promise<boolean> {
    try {
      const retarget =
        spec.upstream.mode === 'forward' && !mayForward.has(app.id);
      if (!retarget && !(await this.poolerCut.pausedPods(app.id)).length) {
        return false;
      }
      const pods = await this.poolerCut.release(app.id, { retarget });
      const resumed = pods.length ? ` (${pods.join(', ')} resumed)` : '';
      this.logger.warn(
        `[pooler-sweep] pooler of ${app.slug} was ${retarget ? 'still forwarding' : 'paused'} outside a cutover; put back to serving${resumed}`,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `[pooler-sweep] pooler of ${app.slug} not released: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async legsOfCuttingOverParents(
    busy: DbMigrationEntity[],
  ): Promise<string[]> {
    const synced = busy.filter(
      (m) => m.status === DbMigrationStatus.SYNCED && m.fullMigrationId,
    );
    if (!synced.length) return [];
    const parents = await this.fullRepo.find({
      where: {
        id: In([...new Set(synced.map((m) => m.fullMigrationId as string))]),
        status: In(CUTTING_OVER),
      },
    });
    const cutting = new Set(parents.map((p) => p.id));
    return synced
      .filter((m) => cutting.has(m.fullMigrationId as string))
      .flatMap((m) => [m.srcAppId, m.dstAppId as string]);
  }
}
