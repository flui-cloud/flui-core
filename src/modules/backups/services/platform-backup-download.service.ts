import { Injectable, NotFoundException } from '@nestjs/common';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { BackupDestinationsService } from './backup-destinations.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';

const LINK_TTL_SECONDS = 600;
const PARTS = ['platform:keys', 'platform:db'] as const;

export interface PlatformBackupFile {
  kind: 'keys' | 'db';
  name: string;
  sizeBytes: number;
  url: string;
}

export interface PlatformBackupDownload {
  jobId: string;
  createdAt: Date;
  expiresAt: Date;
  files: PlatformBackupFile[];
}

/**
 * Time-limited links to the two objects of a platform backup, so a rebuild or
 * a restore drill can fetch them without the storage credentials ever leaving
 * the API. What is fetched is ciphertext sealed to the operator's key.
 */
@Injectable()
export class PlatformBackupDownloadService {
  now: () => number = () => Date.now();

  constructor(
    private readonly artifacts: BackupArtifactRepository,
    private readonly destinations: BackupDestinationsService,
    private readonly storage: StorageBackendFactory,
  ) {}

  async links(jobId?: string): Promise<PlatformBackupDownload> {
    const job = jobId ?? (await this.artifacts.latestPlatformJobId());
    if (!job) {
      throw new NotFoundException('No platform backup has been taken yet.');
    }
    const found = await this.artifacts.listByJob(job);
    const parts = PARTS.map((ref) => found.find((a) => a.engineRef === ref));
    if (parts.some((p) => !p)) {
      throw new NotFoundException(
        `Backup job ${job} is not a completed platform backup.`,
      );
    }
    const files = await Promise.all(
      (parts as BackupArtifactEntity[]).map((artifact) => this.file(artifact)),
    );
    return {
      jobId: job,
      createdAt: (parts[0] as BackupArtifactEntity).createdAt,
      expiresAt: new Date(this.now() + LINK_TTL_SECONDS * 1000),
      files,
    };
  }

  private async file(
    artifact: BackupArtifactEntity,
  ): Promise<PlatformBackupFile> {
    const location = (artifact.locations ?? []).find(
      (l) =>
        l.state === ArtifactLocationState.AVAILABLE ||
        l.state === ArtifactLocationState.VERIFIED,
    );
    if (!location) {
      throw new NotFoundException(
        `The ${artifact.engineRef} part of backup job ${artifact.backupJobId} is not available at any destination.`,
      );
    }
    const destination = await this.destinations.findById(
      location.destinationId,
    );
    const url = await this.storage
      .forProvider(destination.provider)
      .presignDownload(
        this.destinations.toCredentials(destination),
        location.objectKeyPrefix,
        LINK_TTL_SECONDS,
      );
    return {
      kind: artifact.engineRef === 'platform:keys' ? 'keys' : 'db',
      name: location.objectKeyPrefix.split('/').pop() ?? artifact.id,
      sizeBytes: Number(artifact.sizeBytes ?? 0),
      url,
    };
  }
}
