import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { RestoreJobEntity } from '../entities/restore-job.entity';
import { RestoreJobStatus } from '../enums/restore-job.enum';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupDestinationsService } from './backup-destinations.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import {
  isEncryptedRepository,
  legacyRepoObjectPrefixes,
} from './pgbackrest-repo.util';

export const PLAINTEXT_RETIRED_KEY = 'plaintextRetiredAt';

/**
 * Deletes an application's plaintext pgBackRest repository once an encrypted
 * one holds a full backup.
 *
 * Deleting first and encrypting later would leave the database with no
 * backup at all for as long as the first encrypted run takes, or forever if
 * it fails, so the only trigger is a recorded, verified-encrypted full.
 */
@Injectable()
export class PgLegacyRepoRetirer {
  private readonly logger = new Logger(PgLegacyRepoRetirer.name);

  constructor(
    private readonly artifacts: BackupArtifactRepository,
    private readonly policies: BackupPolicyRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly destinations: BackupDestinationsService,
    private readonly storage: StorageBackendFactory,
    @InjectRepository(RestoreJobEntity)
    private readonly restoreRepo: Repository<RestoreJobEntity>,
  ) {}

  async retire(appId: string, latest: BackupArtifactEntity): Promise<void> {
    const policy = await this.policies.findDbPolicyForApp(appId);
    if (!policy || policy.metadata?.[PLAINTEXT_RETIRED_KEY]) return;

    const rows = await this.artifacts.listDbArtifactsForApp(appId);
    const pgRows = rows.filter((a) => !a.engine || a.engine === 'postgres');
    const hasEncryptedFull = [latest, ...pgRows].some(
      (a) =>
        isEncryptedRepository(a.manifestSummary) &&
        a.manifestSummary?.backupType === 'full',
    );
    if (!hasEncryptedFull) return;

    const legacy = pgRows.filter(
      (a) =>
        !a.manifestSummary?.repository && !a.metadata?.[PLAINTEXT_RETIRED_KEY],
    );
    if (await this.restoreRunningAgainst(legacy)) {
      this.logger.log(
        `[pg-retire] app=${appId}: a restore is reading the plaintext repository; retiring it on a later run`,
      );
      return;
    }

    const destinationIds = new Set<string>(
      (policy.destinations ?? []).map((d) => d.destinationId),
    );
    for (const a of legacy) {
      for (const l of a.locations ?? []) destinationIds.add(l.destinationId);
    }

    const { cleaned, complete } = await this.cleanDestinations(
      appId,
      destinationIds,
    );

    const at = new Date().toISOString();
    await this.markRetired(legacy, cleaned, at);

    if (complete) {
      await this.policies.update(policy.id, {
        metadata: { ...policy.metadata, [PLAINTEXT_RETIRED_KEY]: at },
      });
      this.logger.log(
        `[pg-retire] app=${appId}: plaintext repository retired; ${legacy.length} artifact(s) marked expired`,
      );
    }
  }

  private async cleanDestinations(
    appId: string,
    destinationIds: Set<string>,
  ): Promise<{ cleaned: Set<string>; complete: boolean }> {
    const cleaned = new Set<string>();
    let complete = true;
    for (const id of destinationIds) {
      const dest = await this.destRepo.findById(id);
      if (!dest) continue;
      try {
        const removed = await this.deletePlaintextObjects(dest, appId);
        cleaned.add(id);
        this.logger.log(
          `[pg-retire] app=${appId} destination=${id}: removed ${removed} plaintext object(s) under ${legacyRepoObjectPrefixes(appId).join(', ')}`,
        );
      } catch (err: any) {
        complete = false;
        this.logger.warn(
          `[pg-retire] app=${appId} destination=${id}: plaintext repository not removed (${err?.message}); retried on the next backup`,
        );
      }
    }
    return { cleaned, complete };
  }

  private async markRetired(
    legacy: BackupArtifactEntity[],
    cleaned: Set<string>,
    at: string,
  ): Promise<void> {
    for (const a of legacy) {
      const gone = (a.locations ?? []).filter((l) =>
        cleaned.has(l.destinationId),
      );
      if (gone.length === 0) continue;
      for (const l of gone) {
        await this.artifacts.updateLocation(l.id, {
          state: ArtifactLocationState.EXPIRED,
          lastError:
            'plaintext repository removed after the first encrypted full backup',
        });
      }
      await this.artifacts.updateArtifactMetadata(a.id, {
        ...a.metadata,
        [PLAINTEXT_RETIRED_KEY]: at,
      });
    }
  }

  /**
   * S3's batch delete reports per-key failures in its answer rather than by
   * throwing, so success is what a second listing finds, not what the delete
   * returned.
   */
  private async deletePlaintextObjects(
    dest: BackupDestinationEntity,
    appId: string,
  ): Promise<number> {
    const creds = this.destinations.toCredentials(dest);
    const backend = this.storage.forProvider(dest.provider);
    let removed = 0;
    for (const prefix of legacyRepoObjectPrefixes(appId)) {
      let cursor: string | undefined;
      do {
        const page = await backend.listObjects(creds, prefix, cursor);
        if (page.keys.length > 0) {
          await backend.deleteObjects(creds, page.keys);
          removed += page.keys.length;
        }
        cursor = page.hasMore ? page.continuationToken : undefined;
      } while (cursor);
      const left = await backend.listObjects(creds, prefix);
      if (left.keys.length > 0) {
        throw new Error(`${left.keys.length}+ object(s) still under ${prefix}`);
      }
    }
    return removed;
  }

  private async restoreRunningAgainst(
    artifacts: BackupArtifactEntity[],
  ): Promise<boolean> {
    if (artifacts.length === 0) return false;
    const running = await this.restoreRepo.count({
      where: {
        artifactId: In(artifacts.map((a) => a.id)),
        status: Not(
          In([
            RestoreJobStatus.COMPLETED,
            RestoreJobStatus.FAILED,
            RestoreJobStatus.CANCELLED,
          ]),
        ),
      },
    });
    return running > 0;
  }
}
