import { BadRequestException, Logger } from '@nestjs/common';
import { Queue } from 'bull';
import { In, Repository } from 'typeorm';
import { describeError } from '../../shared/utils/error.util';
import { AppMigrationEntity } from '../entities/app-migration.entity';
import { AppMigrationStatus } from '../enums/app-migration.enum';
import { APP_MIGRATION_JOB_TYPES } from '../app-migration.constants';

/** What the migration queue still holds, and what it should hold again after a restart. */
export class AppMigrationJobs {
  constructor(
    private readonly queue: Queue,
    private readonly migRepo: Repository<AppMigrationEntity>,
    private readonly logger: Logger,
  ) {}

  async queueCutover(
    id: string,
    mig: AppMigrationEntity,
    fromOrchestrator: boolean,
  ): Promise<void> {
    if (mig.status === AppMigrationStatus.CUTOVER) {
      if (fromOrchestrator) {
        // The orchestrator finishes a leg it stopped after opening the bridge;
        // the job that opened it may still be returning, a cutover job may not.
        if (await this.cutoverJobRunning(id)) return;
      } else if ((await this.liveJobIds()).has(id)) {
        throw new BadRequestException(
          `The cutover of migration ${id} is still running`,
        );
      }
      await this.queue.add(APP_MIGRATION_JOB_TYPES.RUN_APP_CUTOVER, {
        migrationId: id,
      });
      return;
    }
    const resume =
      mig.status === AppMigrationStatus.FAILED &&
      mig.bridgeState?.state === 'active';
    if (mig.status !== AppMigrationStatus.READY && !resume) {
      throw new BadRequestException(
        `Cutover is only available in state '${AppMigrationStatus.READY}', or after a failure once the bridge is open (current: '${mig.status}')`,
      );
    }
    if (resume) {
      mig.status = AppMigrationStatus.CUTOVER;
      mig.errorMessage = undefined;
      await this.migRepo.save(mig);
    }
    await this.queue.add(APP_MIGRATION_JOB_TYPES.RUN_APP_CUTOVER, {
      migrationId: id,
    });
  }

  async queueBridgeOpen(id: string, mig: AppMigrationEntity): Promise<void> {
    if (!mig.fullMigrationId) {
      throw new BadRequestException(
        'Opening the bridge ahead of the cutover is only for a full migration, before its database is fenced',
      );
    }
    if (mig.bridgeState?.state === 'active') return;
    // A crash may leave the leg in CUTOVER before its bridge went up: opened
    // again unless a job still holds it, which will finish the opening.
    const crashedMidOpen = mig.status === AppMigrationStatus.CUTOVER;
    if (crashedMidOpen && (await this.liveJobIds()).has(id)) return;
    if (
      (mig.status !== AppMigrationStatus.READY && !crashedMidOpen) ||
      mig.bridgeState?.mode !== 'bridge'
    ) {
      throw new BadRequestException(
        `The bridge of migration ${id} cannot be opened in state '${mig.status}' (bridge ${mig.bridgeState?.mode ?? 'none'})`,
      );
    }
    await this.queue.add(APP_MIGRATION_JOB_TYPES.RUN_APP_BRIDGE_OPEN, {
      migrationId: id,
    });
  }

  async requeueInterrupted(): Promise<void> {
    try {
      const found = await this.migRepo.find({
        where: {
          status: In([
            AppMigrationStatus.PENDING,
            AppMigrationStatus.PROVISIONING,
            AppMigrationStatus.CUTOVER,
          ]),
        },
      });
      // A leg in CUTOVER is driven by its full migration, which may have
      // stopped it on purpose with the bridge open ahead of the promote.
      const stuck = found.filter(
        (m) =>
          m.status === AppMigrationStatus.PENDING ||
          m.status === AppMigrationStatus.PROVISIONING ||
          (m.status === AppMigrationStatus.CUTOVER && !m.fullMigrationId),
      );
      if (stuck.length === 0) return;
      const live = await this.liveJobIds();
      for (const mig of stuck) {
        if (live.has(mig.id)) continue;
        const cutover = mig.status === AppMigrationStatus.CUTOVER;
        await this.queue.add(
          cutover
            ? APP_MIGRATION_JOB_TYPES.RUN_APP_CUTOVER
            : APP_MIGRATION_JOB_TYPES.RUN_APP_MIGRATION,
          { migrationId: mig.id },
          {
            jobId: `${cutover ? 'resume-cutover' : 'resume-run'}:${mig.id}:${mig.updatedAt?.getTime() ?? 0}`,
          },
        );
        this.logger.warn(
          `[app-migration] ${mig.id}: ${mig.status} found without a job at startup — queued again`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[app-migration] could not look for interrupted migrations: ${describeError(err)}`,
      );
    }
  }

  async liveJobIdsFor(
    migs: AppMigrationEntity[],
  ): Promise<Set<string> | undefined> {
    if (!migs.some((m) => m.status === AppMigrationStatus.CUTOVER)) {
      return new Set();
    }
    return this.liveJobIds().catch(() => undefined);
  }

  async cutoverJobRunning(id: string): Promise<boolean> {
    const jobs = await this.queue.getJobs(['active', 'waiting', 'delayed']);
    return jobs.some(
      (j) =>
        (j?.data as { migrationId?: string } | undefined)?.migrationId === id &&
        (j?.name === APP_MIGRATION_JOB_TYPES.RUN_APP_CUTOVER ||
          j?.name === APP_MIGRATION_JOB_TYPES.RUN_APP_MIGRATION),
    );
  }

  /** Migration ids a queued, delayed or running job still holds. */
  async liveJobIds(): Promise<Set<string>> {
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
