import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import { DbReplicationKind } from '../enums/db-replication-status.enum';
import { pausedAndOpen } from '../utils/pooler-cut.core';
import {
  DB_LIFECYCLE_JOB_TYPES,
  DB_LIFECYCLE_QUEUE,
} from '../db-lifecycle.constants';

/**
 * After a restart, physical migrations are handed back to their jobs unless
 * Bull still holds one for them. A run left before SYNCED resumes from the
 * phase it reached; one in CUTOVER goes to the cutover job, which asks the
 * destination whether promote happened: the row cannot say, the database can.
 */
@Injectable()
export class DbMigrationRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DbMigrationRecoveryService.name);

  constructor(
    @InjectRepository(DbMigrationEntity)
    private readonly migRepo: Repository<DbMigrationEntity>,
    @InjectQueue(DB_LIFECYCLE_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const held = await this.heldMigrationIds();
      await this.resumeRuns(held);
      await this.resumeCutovers(held);
    } catch (err: any) {
      this.logger.error(
        `[db-migration] could not resume interrupted migrations: ${err?.message ?? err}`,
      );
    }
  }

  async resumeRuns(held: Set<string>): Promise<number> {
    const stuck = (
      await this.migRepo.find({
        where: {
          status: In([
            DbMigrationStatus.PENDING,
            DbMigrationStatus.PROVISIONING,
            DbMigrationStatus.REPLICATING,
          ]),
          kind: DbReplicationKind.PHYSICAL,
        },
      })
    ).filter((m) => !held.has(m.id));
    for (const mig of stuck) {
      await this.queue.add(DB_LIFECYCLE_JOB_TYPES.RUN_DB_MIGRATION, {
        migrationId: mig.id,
      });
      this.logger.warn(
        `[db-migration] ${mig.id} was ${mig.status} at start-up with no job — resuming it`,
      );
    }
    return stuck.length;
  }

  async resumeCutovers(held: Set<string>): Promise<number> {
    const stuck = (
      await this.migRepo.find({
        where: {
          status: DbMigrationStatus.CUTOVER,
          kind: DbReplicationKind.PHYSICAL,
        },
      })
    ).filter((m) => !held.has(m.id));
    for (const mig of stuck) {
      await this.queue.add(DB_LIFECYCLE_JOB_TYPES.RUN_DB_CUTOVER, {
        migrationId: mig.id,
      });
      this.logger.warn(
        `[db-migration] ${mig.id} was in cutover at start-up — asking the destination where it stands${
          pausedAndOpen(mig.poolerCut)
            ? `; its poolers are paused since ${mig.poolerCut?.pausedAt}, and are resumed with the source (destination still a standby) or retargeted first (destination promoted)`
            : ''
        }`,
      );
    }
    return stuck.length;
  }

  /** Migrations a job is still active, waiting or scheduled for. */
  private async heldMigrationIds(): Promise<Set<string>> {
    const jobs = await this.queue.getJobs(['active', 'waiting', 'delayed']);
    return new Set(
      jobs
        .map(
          (j) => (j?.data as { migrationId?: string } | undefined)?.migrationId,
        )
        .filter((id): id is string => !!id),
    );
  }
}
