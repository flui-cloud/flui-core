import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupDestinationsService } from './backup-destinations.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import { StorageBackendCredentials } from '../../storage/interfaces/backup-storage-backend.interface';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import {
  isCryptSummary,
  isEncryptedObjectKey,
} from '../utils/rclone-crypt.util';
import { trimSlashes } from '../utils/destination-layout.util';

export const PLAINTEXT_RETIRED_REASON =
  'plaintext copy deleted after the first encrypted backup (F-090)';

const GONE = [ArtifactLocationState.EXPIRED, ArtifactLocationState.MISSING];

export interface RetirementReport {
  deletedKeys: number;
  retiredArtifacts: string[];
}

/**
 * Removes an application's plaintext backups once an encrypted one of the same
 * engine exists, and marks them gone in the ledger. Callers invoke it only
 * after the encrypted backup has been recorded; running it again finds nothing.
 */
@Injectable()
export class PlaintextRetirementService {
  private readonly logger = new Logger(PlaintextRetirementService.name);

  constructor(
    @InjectRepository(BackupArtifactEntity)
    private readonly artifactRepo: Repository<BackupArtifactEntity>,
    @InjectRepository(BackupArtifactLocationEntity)
    private readonly locationRepo: Repository<BackupArtifactLocationEntity>,
    private readonly destRepo: BackupDestinationRepository,
    private readonly destinations: BackupDestinationsService,
    private readonly storage: StorageBackendFactory,
  ) {}

  /**
   * Engines whose object names are all Flui's (dumps, MariaDB bases and binary
   * logs): every non-`.bin` key under the application's engine prefix is a
   * plaintext leftover, recorded or not.
   */
  async afterEncryptedDatabaseBackup(args: {
    appId: string;
    engine: string;
    enginePrefix: string;
    destinationId: string;
    encryptedArtifactId: string;
  }): Promise<RetirementReport> {
    const prefix = trimSlashes(args.enginePrefix);
    if (!prefix.includes(args.appId)) {
      throw new Error(
        `Refusing to retire plaintext under "${args.enginePrefix}": not an application prefix`,
      );
    }
    const legacy = (
      await this.artifactRepo.find({
        where: {
          applicationId: args.appId,
          engineClass: BackupEngineClass.DATABASE,
          engine: args.engine,
          id: Not(args.encryptedArtifactId),
        },
        relations: ['locations'],
      })
    ).filter((a) => !isCryptSummary(a.manifestSummary));

    const destinationIds = new Set<string>([args.destinationId]);
    for (const a of legacy) {
      for (const l of a.locations ?? []) destinationIds.add(l.destinationId);
    }

    const report: RetirementReport = { deletedKeys: 0, retiredArtifacts: [] };
    for (const destinationId of destinationIds) {
      const creds = await this.credentialsFor(destinationId);
      if (!creds) continue;
      report.deletedKeys += await this.deleteWhere(
        creds,
        `${prefix}/`,
        (key) => !isEncryptedObjectKey(key),
      );
      report.retiredArtifacts.push(
        ...(await this.markGone(legacy, destinationId)),
      );
    }
    this.log(`${args.engine} app=${args.appId}`, report);
    return report;
  }

  /**
   * Volume copies hold the application's own file names, so plaintext is found
   * by artifact, never by name: each unencrypted copy of this volume loses its
   * whole prefix.
   */
  async afterEncryptedVolumeCopy(args: {
    appId: string;
    volumeName: string;
    encryptedArtifactId: string;
  }): Promise<RetirementReport> {
    const legacy = (
      await this.artifactRepo.find({
        where: {
          applicationId: args.appId,
          volumeName: args.volumeName,
          engineClass: BackupEngineClass.VOLUME_COPY,
          id: Not(args.encryptedArtifactId),
        },
        relations: ['locations'],
      })
    ).filter(
      (a) =>
        a.manifestSummary?.sink === 's3-archive' &&
        !isCryptSummary(a.manifestSummary),
    );

    const report: RetirementReport = { deletedKeys: 0, retiredArtifacts: [] };
    for (const artifact of legacy) {
      for (const location of artifact.locations ?? []) {
        if (GONE.includes(location.state)) continue;
        const prefix = trimSlashes(location.objectKeyPrefix);
        if (!prefix.includes('/')) continue;
        const creds = await this.credentialsFor(location.destinationId);
        if (!creds) continue;
        // The copy's prefix is a full key, written by rclone at the bucket
        // root: the destination's own prefix is already inside it.
        report.deletedKeys += await this.deleteWhere(
          { ...creds, pathPrefix: undefined },
          `${prefix}/`,
          () => true,
        );
        report.retiredArtifacts.push(
          ...(await this.markGone([artifact], location.destinationId)),
        );
      }
    }
    this.log(`volume ${args.volumeName} app=${args.appId}`, report);
    return report;
  }

  private async credentialsFor(
    destinationId: string,
  ): Promise<StorageBackendCredentials | null> {
    const dest = await this.destRepo.findById(destinationId);
    if (!dest) {
      this.logger.warn(
        `[retire-plaintext] destination ${destinationId} no longer exists; its plaintext copies are left as they are`,
      );
      return null;
    }
    return this.destinations.toCredentials(dest);
  }

  private async deleteWhere(
    creds: StorageBackendCredentials,
    prefix: string,
    select: (key: string) => boolean,
  ): Promise<number> {
    const backend = this.storage.forProvider(
      creds.provider as StorageBackendProvider,
    );
    const doomed: string[] = [];
    let token: string | undefined;
    do {
      const page = await backend.listObjects(creds, prefix, token);
      doomed.push(...page.keys.filter(select));
      token = page.hasMore ? page.continuationToken : undefined;
    } while (token);
    if (doomed.length) await backend.deleteObjects(creds, doomed);
    for (const key of doomed) {
      this.logger.log(`[retire-plaintext] deleted ${creds.bucket}/${key}`);
    }
    return doomed.length;
  }

  private async markGone(
    artifacts: BackupArtifactEntity[],
    destinationId: string,
  ): Promise<string[]> {
    const ids = artifacts
      .filter((a) =>
        (a.locations ?? []).some(
          (l) => l.destinationId === destinationId && !GONE.includes(l.state),
        ),
      )
      .map((a) => a.id);
    if (!ids.length) return [];
    const retiredAt = new Date().toISOString();
    for (const artifact of artifacts.filter((a) => ids.includes(a.id))) {
      if (artifact.metadata?.plaintextRetiredAt) continue;
      await this.artifactRepo.update(artifact.id, {
        metadata: {
          ...artifact.metadata,
          plaintextRetiredAt: retiredAt,
        } as BackupArtifactEntity['metadata'],
      });
    }
    await this.locationRepo.update(
      {
        artifactId: In(ids),
        destinationId,
        state: Not(In(GONE)),
      },
      {
        state: ArtifactLocationState.EXPIRED,
        lastError: PLAINTEXT_RETIRED_REASON,
      },
    );
    return ids;
  }

  private log(scope: string, report: RetirementReport): void {
    if (!report.deletedKeys && !report.retiredArtifacts.length) return;
    this.logger.log(
      `[retire-plaintext] ${scope}: ${report.deletedKeys} plaintext object(s) deleted, ` +
        `${report.retiredArtifacts.length} artifact location(s) marked expired` +
        (report.retiredArtifacts.length
          ? ` (${report.retiredArtifacts.join(', ')})`
          : ''),
    );
  }
}
