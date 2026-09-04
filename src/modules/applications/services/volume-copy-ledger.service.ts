import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupJobEntity } from '../../backups/entities/backup-job.entity';
import { BackupArtifactEntity } from '../../backups/entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../../backups/entities/backup-artifact-location.entity';
import {
  BackupJobStatus,
  BackupJobTriggerType,
} from '../../backups/enums/backup-job.enum';
import { BackupEngineClass } from '../../backups/enums/backup-engine-class.enum';
import { DestinationRole } from '../../backups/enums/destination-role.enum';
import { ArtifactLocationState } from '../../backups/enums/artifact-location-state.enum';

/**
 * What Flui did to the writers before copying — never a claim about the volume.
 *
 * An earlier design had a third value, `idle`, for a copy taken with no flag.
 * It was dropped because Flui cannot prove it: a read-only mount is a per-pod
 * flag rather than a freeze, RWO does not exclude another pod on the same node,
 * and even a per-file check cannot see two files that are each intact but
 * inconsistent with each other. Recording `idle` would have been the ledger
 * asserting the one thing the operation never checked.
 */
export type QuiesceMode = 'none' | 'writers-stopped' | 'engine-hook';

export interface RecordedVolumeCopy {
  clusterId: string;
  applicationId: string;
  applicationSlug: string;
  volumeName: string;
  userId?: string;
  /** The export primitive's own id — `engineRef` on the artifact. */
  exportId: string;
  sink: 'pvc-clone' | 's3-archive';
  sizeBytes?: number;
  /** pvc-clone: the sibling PVC the copy landed in. */
  clonePvcName?: string;
  /** s3-archive: a registered destination, when the copy went to one. */
  destinationId?: string;
  /** s3-archive: where under the bucket the copy lives. */
  objectKeyPrefix?: string;
  /** s3-archive: recorded when the bucket is not a registered destination. */
  bucket?: string;
  /** What was done to the writers. Defaults to `none` — the honest default. */
  quiesce?: QuiesceMode;
  /** Running pods with the volume mounted when the copy began. */
  writersAtStart?: number;
  /**
   * The engine whose data directory was found on the volume, or null when the
   * probe ran and found none. Undefined when it did not run.
   *
   * An observation, not a verdict: a volume with no marker may still hold a
   * database Flui does not recognise, and the row says only what was seen.
   */
  dataDirectoryDetected?: string | null;
  /** Set when the user copied a detected data directory anyway. */
  acknowledgedInconsistent?: boolean;
  /** Which engine mechanism made the copy safe, when one did. */
  hook?: string;
  /**
   * The policy that scheduled this copy, when one did.
   *
   * Load-bearing for retention: the reaper never prunes a copy whose job has
   * no policy, because that copy was made by a person and only a person may
   * remove it. A scheduled copy recorded without its policy would inherit that
   * protection and accumulate forever — the exact failure the schedule needs
   * pruning to avoid.
   */
  policyId?: string;
  /** When retention says this copy stops being kept. */
  expiresAt?: Date;
}

/**
 * Writes an ad-hoc volume copy into the same ledger as every scheduled backup.
 *
 * A copy is one engine among several, not a separate world, so it gets a job
 * and an artifact like the rest — with `policyId` null, because nothing
 * schedules it.
 *
 * Recording is best-effort by design: the copy already exists on the cluster
 * when this runs, and failing the user's command because the bookkeeping row
 * did not save would be the wrong trade. A missing row is a listing gap; a
 * failed command after a successful copy is a lie.
 */
@Injectable()
export class VolumeCopyLedgerService {
  private readonly logger = new Logger(VolumeCopyLedgerService.name);

  constructor(
    @InjectRepository(BackupJobEntity)
    private readonly jobRepo: Repository<BackupJobEntity>,
    @InjectRepository(BackupArtifactEntity)
    private readonly artifactRepo: Repository<BackupArtifactEntity>,
    @InjectRepository(BackupArtifactLocationEntity)
    private readonly locationRepo: Repository<BackupArtifactLocationEntity>,
  ) {}

  /**
   * Registers copies that already exist on the cluster but predate the ledger.
   *
   * Every installation running before this shipped has clones nothing recorded.
   * Reconciling on the read path rather than in a one-off command means the
   * ledger heals itself exactly where somebody looks, instead of staying
   * permanently incomplete because nobody knew a command existed. Idempotent on
   * `engineRef` — the export's own id — so repeated reads add nothing.
   *
   * Best effort, like {@link record}: a failure here must not break a listing.
   */
  async reconcile(
    clusterId: string,
    applicationId: string,
    applicationSlug: string,
    existing: ReadonlyArray<{
      exportId: string;
      sourcePvcName?: string;
      actualBytes?: number;
    }>,
    /**
     * Whether the cluster answered. The listing this is reconciled against
     * returns an empty array both when there are no copies and when the API
     * call failed, so without a separate signal "the cluster is unreachable"
     * and "every copy was deleted" are the same input — and acting on the
     * second when it was the first would erase the ledger.
     */
    clusterReachable = false,
  ): Promise<void> {
    if (existing.length === 0 && !clusterReachable) return;
    try {
      const known = new Set(
        (
          await this.artifactRepo.find({
            where: { applicationId },
            select: { engineRef: true },
          })
        ).map((a) => a.engineRef),
      );
      // Rows whose clone is no longer on the cluster: removed by hand, or by a
      // delete from before the ledger learned to forget. Deliberately only
      // when the cluster returned something — a transient empty listing must
      // never be read as "every copy was deleted".
      const live = new Set(existing.map((c) => c.exportId.slice(0, 64)));
      const orphans = await this.artifactRepo.find({
        where: {
          applicationId,
          engineClass: BackupEngineClass.VOLUME_COPY,
        },
      });
      for (const orphan of orphans) {
        // Only clones are listed from the cluster, so an S3 archive missing
        // from that list is expected and must not be swept.
        if (orphan.manifestSummary?.sink !== 'pvc-clone') continue;
        if (live.has(orphan.engineRef)) continue;
        await this.forget(applicationId, orphan.engineRef);
      }

      for (const copy of existing) {
        const ref = copy.exportId.slice(0, 64);
        if (known.has(ref)) continue;
        await this.record({
          clusterId,
          applicationId,
          applicationSlug,
          volumeName: copy.sourcePvcName ?? '',
          exportId: copy.exportId,
          sink: 'pvc-clone',
          sizeBytes: copy.actualBytes,
          clonePvcName: copy.exportId,
        });
      }
    } catch (err: any) {
      this.logger.warn(
        `[volume-copy] could not reconcile pre-existing copies for ${applicationSlug}: ${err?.message}`,
      );
    }
  }

  /**
   * Takes a copy out of the ledger once it no longer exists.
   *
   * A row left behind is worse than no row at all — `backup status` reads it
   * and says the application is protected by something that has been removed,
   * which is the exact failure this ledger was built to prevent.
   *
   * Deleted rather than marked: the copy is gone from the cluster and from the
   * bucket, so there is no artifact left for a row to describe, and a
   * tombstone would only be another thing to filter everywhere it is read.
   */
  async forget(applicationId: string, exportId: string): Promise<void> {
    try {
      const artifacts = await this.artifactRepo.find({
        where: { applicationId, engineRef: exportId.slice(0, 64) },
      });
      for (const artifact of artifacts) {
        await this.locationRepo.delete({ artifactId: artifact.id });
        await this.artifactRepo.delete({ id: artifact.id });
        if (artifact.backupJobId) {
          await this.jobRepo.delete({ id: artifact.backupJobId });
        }
      }
    } catch (err: any) {
      // The copy is already gone; failing the user's delete over bookkeeping
      // would report a failure for something that succeeded. The row is stale
      // until the next reconcile, which is the lesser wrong.
      this.logger.warn(
        `[volume-copy] ${exportId} was deleted but its ledger row could not be ` +
          `removed — it will keep being listed: ${err?.message}`,
      );
    }
  }

  async record(copy: RecordedVolumeCopy): Promise<BackupArtifactEntity | null> {
    try {
      const now = new Date();
      const job = await this.jobRepo.save(
        this.jobRepo.create({
          policyId: copy.policyId,
          clusterId: copy.clusterId,
          applicationId: copy.applicationId,
          volumeName: copy.volumeName,
          userId: copy.userId,
          triggerType: copy.policyId
            ? BackupJobTriggerType.SCHEDULED
            : BackupJobTriggerType.ON_DEMAND,
          triggerContext: { sink: copy.sink, app: copy.applicationSlug },
          status: BackupJobStatus.COMPLETED,
          startedAt: now,
          finishedAt: now,
        }),
      );

      const artifact = await this.artifactRepo.save(
        this.artifactRepo.create({
          backupJobId: job.id,
          clusterId: copy.clusterId,
          applicationId: copy.applicationId,
          volumeName: copy.volumeName,
          engineClass: BackupEngineClass.VOLUME_COPY,
          engineRef: copy.exportId.slice(0, 64),
          expiresAt: copy.expiresAt,
          sizeBytes:
            copy.sizeBytes === undefined ? undefined : String(copy.sizeBytes),
          manifestSummary: {
            sink: copy.sink,
            applicationSlug: copy.applicationSlug,
            sourcePvcName: copy.volumeName,
            ...(copy.clonePvcName ? { clonePvcName: copy.clonePvcName } : {}),
            ...(copy.bucket ? { bucket: copy.bucket } : {}),
            // What Flui did and what it saw, so a reader can draw their own
            // conclusion about consistency instead of trusting a verdict this
            // code is not in a position to give.
            quiesce: copy.quiesce ?? 'none',
            ...(copy.writersAtStart === undefined
              ? {}
              : { writersAtStart: copy.writersAtStart }),
            ...(copy.dataDirectoryDetected === undefined
              ? {}
              : { dataDirectoryDetected: copy.dataDirectoryDetected }),
            ...(copy.acknowledgedInconsistent
              ? { acknowledgedInconsistent: true }
              : {}),
            ...(copy.hook ? { hook: copy.hook } : {}),
            // A clone lives on the application's own disk and carries its
            // label, so removing the application removes the clone with it.
            survivesAppDeletion: copy.sink === 's3-archive',
          },
        }),
      );

      // Only an S3 copy has a location: a clone is a PVC in the cluster, not an
      // object at a prefix, and inventing a location row for it would make
      // `restore preview` count objects that were never written.
      if (copy.sink === 's3-archive' && copy.destinationId) {
        await this.locationRepo.save(
          this.locationRepo.create({
            artifactId: artifact.id,
            destinationId: copy.destinationId,
            role: DestinationRole.PRIMARY,
            state: ArtifactLocationState.AVAILABLE,
            objectKeyPrefix: copy.objectKeyPrefix ?? '',
            bytesStored:
              copy.sizeBytes === undefined ? undefined : String(copy.sizeBytes),
          }),
        );
      }

      return artifact;
    } catch (err: any) {
      this.logger.error(
        `[volume-copy] the copy ${copy.exportId} succeeded but was not recorded ` +
          `in the ledger — it will not appear in backup listings: ${err?.message}`,
      );
      return null;
    }
  }
}
