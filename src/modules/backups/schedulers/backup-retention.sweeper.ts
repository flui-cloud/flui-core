import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Not, Repository } from 'typeorm';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { RestoreJobEntity } from '../entities/restore-job.entity';
import { RestoreJobStatus } from '../enums/restore-job.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupDestinationsService } from '../services/backup-destinations.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

/**
 * How many artifacts one pass may delete.
 *
 * A backlog of already-expired artifacts meets a single pass all at once.
 * Without a cap that is one enormous burst of deletions against the object
 * store, in a single log line nobody can audit.
 * Spread it across passes instead — the backlog drains in hours, and the log
 * reads as a count per pass.
 */
const MAX_DELETIONS_PER_SWEEP = 25;

/** Give up automatic retries and ask for a human after this many passes. */
const MAX_PRUNE_ATTEMPTS = 5;

/**
 * Deletes what a policy's retention said would be deleted.
 *
 * Two engines prune themselves: Velero expires its own Backups by TTL, and
 * pgBackRest expires its repository by `repo1-retention-full`. The two classes
 * where Flui is the only owner, platform dumps and volume copies, would
 * otherwise accumulate forever — on the dedicated storage class that is the
 * application's own disk.
 *
 * So this reaper deletes only what Flui owns, and for the self-pruning classes
 * it reconciles instead: the rows are what go stale there, not the data.
 *
 * Every rule below exists to make an unattended delete safe rather than fast.
 */
@Injectable()
export class BackupRetentionSweeper {
  private readonly logger = new Logger(BackupRetentionSweeper.name);

  constructor(
    @InjectRepository(BackupArtifactEntity)
    private readonly artifactRepo: Repository<BackupArtifactEntity>,
    @InjectRepository(BackupArtifactLocationEntity)
    private readonly locationRepo: Repository<BackupArtifactLocationEntity>,
    @InjectRepository(BackupJobEntity)
    private readonly jobRepo: Repository<BackupJobEntity>,
    @InjectRepository(RestoreJobEntity)
    private readonly restoreRepo: Repository<RestoreJobEntity>,
    @InjectRepository(BackupDestinationEntity)
    private readonly destRepo: Repository<BackupDestinationEntity>,
    private readonly destinations: BackupDestinationsService,
    private readonly storage: StorageBackendFactory,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    const candidates = await this.findExpired();
    if (candidates.length === 0) return;

    let deleted = 0;
    for (const artifact of candidates) {
      if (deleted >= MAX_DELETIONS_PER_SWEEP) break;
      try {
        if (await this.mustKeep(artifact)) continue;
        await this.prune(artifact);
        deleted += 1;
      } catch (err: any) {
        await this.recordFailure(artifact, err?.message ?? String(err));
      }
    }
    if (deleted > 0) {
      this.logger.log(
        `[retention] pruned ${deleted} expired artifact(s); ${candidates.length - deleted} candidate(s) remain for the next pass`,
      );
    }
  }

  /**
   * Expired artifacts that a policy owns.
   *
   * An artifact with no `expiresAt` is permanent and stays so. One whose job
   * has no `policyId` was made by hand — `flui app snapshot`, `flui app
   * backup` — and nothing scheduled it, so nothing may unschedule it either;
   * deleting it is the person's call, through `snapshot delete`.
   */
  private async findExpired(): Promise<BackupArtifactEntity[]> {
    const rows = await this.artifactRepo.find({
      where: { expiresAt: LessThanOrEqual(new Date()) },
      order: { expiresAt: 'ASC' },
      take: MAX_DELETIONS_PER_SWEEP * 4,
    });
    if (rows.length === 0) return [];

    const jobs = await this.jobRepo.find({
      where: { id: In(rows.map((r) => r.backupJobId).filter(Boolean)) },
      select: { id: true, policyId: true },
    });
    const scheduled = new Set(jobs.filter((j) => j.policyId).map((j) => j.id));
    return rows.filter((r) => scheduled.has(r.backupJobId));
  }

  /**
   * The two refusals that make the difference between retention and data loss.
   *
   * A policy's floor is one: whatever the schedule and the dates say, the most
   * recent copy of a volume is not deleted, because a retention window that
   * has quietly emptied is indistinguishable from one that was never set up
   * until the day somebody needs it.
   */
  private async mustKeep(artifact: BackupArtifactEntity): Promise<boolean> {
    const inFlight = await this.restoreRepo.count({
      where: {
        artifactId: artifact.id,
        status: Not(
          In([
            RestoreJobStatus.COMPLETED,
            RestoreJobStatus.FAILED,
            RestoreJobStatus.CANCELLED,
          ]),
        ),
      },
    });
    if (inFlight > 0) {
      this.logger.log(
        `[retention] keeping ${artifact.id}: a restore is still running against it`,
      );
      return true;
    }

    const newer = await this.artifactRepo.count({
      where: {
        clusterId: artifact.clusterId,
        engineClass: artifact.engineClass,
        ...(artifact.applicationId
          ? { applicationId: artifact.applicationId }
          : {}),
        ...(artifact.volumeName ? { volumeName: artifact.volumeName } : {}),
      },
    });
    // `count` includes this row, so a lone survivor counts one.
    if (newer <= 1) {
      this.logger.log(
        `[retention] keeping ${artifact.id}: it is the only copy left of what it protects`,
      );
      return true;
    }
    return false;
  }

  /**
   * Object first, row second.
   *
   * Deleting the row first and failing on the object leaks storage nothing
   * points at any more — the exact leak the ledger was built to close. The
   * other order leaves a row describing an object that is gone, which the
   * volume-copy reconcile already heals on the read path.
   */
  private async prune(artifact: BackupArtifactEntity): Promise<void> {
    const owned =
      artifact.engineClass === BackupEngineClass.PLATFORM ||
      artifact.engineClass === BackupEngineClass.VOLUME_COPY;
    if (!owned) {
      // Velero expires its own Backups by TTL and pgBackRest its repository by
      // retention. Deleting their objects behind their backs corrupts a chain
      // Flui does not own; the row is what goes stale here, so drop the row.
      await this.forgetRows(artifact);
      return;
    }

    const locations = await this.locationRepo.find({
      where: { artifactId: artifact.id },
    });
    for (const location of locations) {
      await this.deleteObjectsAt(location);
    }
    await this.forgetRows(artifact);
  }

  private async deleteObjectsAt(
    location: BackupArtifactLocationEntity,
  ): Promise<void> {
    if (!location.destinationId || !location.objectKeyPrefix) return;
    const dest = await this.destRepo.findOne({
      where: { id: location.destinationId },
    });
    if (!dest) return;

    const creds = this.destinations.toCredentials(dest);
    const backend = this.storage.forProvider(
      dest.provider as StorageBackendProvider,
    );
    let cursor: string | undefined;
    do {
      const page = await backend.listObjects(
        creds,
        location.objectKeyPrefix,
        cursor,
      );
      if (page.keys.length > 0) await backend.deleteObjects(creds, page.keys);
      cursor = page.hasMore ? page.continuationToken : undefined;
    } while (cursor);
  }

  private async forgetRows(artifact: BackupArtifactEntity): Promise<void> {
    await this.locationRepo.delete({ artifactId: artifact.id });
    await this.artifactRepo.delete({ id: artifact.id });
  }

  /**
   * A failed delete is remembered on the row, not retried forever in silence.
   *
   * Storage that will not answer is a real condition — expired credentials, a
   * bucket removed under Flui — and a reaper that keeps trying every hour
   * without saying so turns it into an invisible cost.
   */
  private async recordFailure(
    artifact: BackupArtifactEntity,
    message: string,
  ): Promise<void> {
    const metadata = (artifact.metadata ?? {}) as Record<string, unknown>;
    const attempts = Number(metadata.pruneAttempts ?? 0) + 1;
    await this.artifactRepo.update(artifact.id, {
      metadata: {
        ...metadata,
        pruneAttempts: attempts,
        pruneLastError: message.slice(0, 500),
      } as BackupArtifactEntity['metadata'],
    });
    const say = attempts >= MAX_PRUNE_ATTEMPTS ? 'error' : 'warn';
    this.logger[say](
      `[retention] could not prune ${artifact.id} (attempt ${attempts}): ${message}` +
        (attempts >= MAX_PRUNE_ATTEMPTS
          ? ' — this artifact is still being paid for and needs a look'
          : ''),
    );
  }
}
