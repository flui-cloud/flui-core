import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BackupArtifactEntity } from '../../backups/entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../../backups/entities/backup-artifact-location.entity';
import { BackupDestinationEntity } from '../../backups/entities/backup-destination.entity';
import { BackupJobEntity } from '../../backups/entities/backup-job.entity';
import { BackupEngineClass } from '../../backups/enums/backup-engine-class.enum';
import { BackupDestinationsService } from '../../backups/services/backup-destinations.service';
import { KopiaRepositoryAccess } from '../../backups/services/kopia-cli.service';
import {
  KopiaSnapshotRecord,
  kopiaLocation,
  kopiaRestorePassword,
} from '../../backups/utils/kopia-repository.util';
import {
  primaryLocationOf,
  volumeRestoreRoute,
} from '../../backups/utils/kopia-restore.util';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import {
  ApplicationVolumeClaim,
  ApplicationVolumeClaimsService,
} from './application-volume-claims.service';
import { ApplicationAccessService } from './application-access.service';
import { stripTrailingSlashes } from '../../../common/utils/url.util';

export interface VolumeBackupTarget {
  app: { id: string; slug: string; k8sNamespace: string; clusterId: string };
  kubeconfig: string;
}

/**
 * The lookups a volume backup's restore and removal share: the artifact and
 * the destination it lives on, the kopia repository's credentials, and the
 * application and volume written into.
 */
@Injectable()
export class VolumeBackupLookupService {
  constructor(
    @InjectRepository(BackupArtifactEntity)
    private readonly artifactRepo: Repository<BackupArtifactEntity>,
    @InjectRepository(BackupArtifactLocationEntity)
    private readonly locationRepo: Repository<BackupArtifactLocationEntity>,
    @InjectRepository(BackupJobEntity)
    private readonly jobRepo: Repository<BackupJobEntity>,
    @InjectRepository(BackupDestinationEntity)
    private readonly destinationRepo: Repository<BackupDestinationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly appResources: AppResourcesRepository,
    private readonly volumeClaims: ApplicationVolumeClaimsService,
    private readonly destinations: BackupDestinationsService,
    private readonly encryption: EncryptionService,
    private readonly access: ApplicationAccessService,
    private readonly storage: StorageBackendFactory,
  ) {}

  async forgetArtifact(artifact: BackupArtifactEntity): Promise<void> {
    await this.locationRepo.delete({ artifactId: artifact.id });
    await this.artifactRepo.delete({ id: artifact.id });
    if (!artifact.backupJobId) return;
    const job = await this.jobRepo.findOne({
      where: { id: artifact.backupJobId },
    });
    const others = await this.artifactRepo.count({
      where: { backupJobId: artifact.backupJobId },
    });
    // A policy run's job is the run's history, and other volumes of the same
    // run hang off it; only the job the ledger made for this one copy goes.
    if (job && !job.policyId && others === 0) {
      await this.jobRepo.delete({ id: job.id });
    }
  }

  async artifactOf(
    applicationId: string,
    artifactId: string,
  ): Promise<BackupArtifactEntity> {
    const artifact = await this.artifactRepo.findOne({
      where: {
        id: artifactId,
        applicationId,
        engineClass: In([BackupEngineClass.VOLUME_COPY]),
      },
      relations: ['locations'],
    });
    if (!artifact) {
      throw new NotFoundException(
        `Volume backup ${artifactId} not found for application ${applicationId}`,
      );
    }
    return artifact;
  }

  kopiaRecord(artifact: BackupArtifactEntity): KopiaSnapshotRecord {
    const route = volumeRestoreRoute(artifact);
    if (route.kind === 'kopia') return route.record;
    throw new BadRequestException(
      route.kind === 'unavailable'
        ? route.reason
        : 'Only kopia backups can be browsed and restored file by file; restore this one whole.',
    );
  }

  async destinationOf(
    destinationId: string | undefined,
  ): Promise<BackupDestinationEntity> {
    const dest = destinationId
      ? await this.destinationRepo.findOne({ where: { id: destinationId } })
      : null;
    if (!dest) {
      throw new BadRequestException(
        'The destination this backup was written to is no longer registered',
      );
    }
    return dest;
  }

  async kopiaCredentials(
    artifact: BackupArtifactEntity,
    dest: BackupDestinationEntity,
  ): Promise<{
    password: string;
    accessKeyId: string;
    secretAccessKey: string;
  }> {
    const creds = this.destinations.toCredentials(dest);
    return {
      password: kopiaRestorePassword(
        this.destinations.decryptPassphrase(dest),
        artifact.applicationId!,
        dest.name,
      ),
      accessKeyId: creds.accessKey,
      secretAccessKey: creds.secretKey,
    };
  }

  async repositoryAccess(
    artifact: BackupArtifactEntity,
    known?: BackupDestinationEntity,
  ): Promise<KopiaRepositoryAccess> {
    const dest =
      known ??
      (await this.destinationOf(primaryLocationOf(artifact)?.destinationId));
    const credentials = await this.kopiaCredentials(artifact, dest);
    return {
      appId: artifact.applicationId!,
      location: kopiaLocation(dest, artifact.applicationId!),
      ...credentials,
    };
  }

  /** The application written into; another one only when the caller may write it. */
  async targetContext(
    sourceAppId: string,
    targetAppId: string | undefined,
    user?: AuthenticatedUser,
  ): Promise<VolumeBackupTarget> {
    const id = targetAppId || sourceAppId;
    const app = await this.applications.findById(id);
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    if (id !== sourceAppId) {
      if (!user) throw new ForbiddenException('Unauthenticated');
      await this.access.assertCan(user, IAM_PERMISSION.APP_WRITE, app);
    }
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new BadRequestException(
        `The cluster of application ${app.slug} cannot be reached`,
      );
    }
    return {
      app: {
        id: app.id,
        slug: app.slug,
        k8sNamespace: app.k8sNamespace,
        clusterId: app.clusterId,
      },
      kubeconfig: this.encryption.decrypt(cluster.kubeconfigEncrypted),
    };
  }

  async targetClaim(
    target: VolumeBackupTarget,
    volumeName: string | undefined | null,
    required: boolean,
  ): Promise<ApplicationVolumeClaim | undefined> {
    const tracked = await this.appResources
      .findByApplicationId(target.app.id)
      .catch(() => []);
    const claims = await this.volumeClaims.resolveForApplication(
      target.kubeconfig,
      target.app,
      tracked,
      { excludeCopies: true },
    );
    if (volumeName) {
      const match = claims.find((c) => c.name === volumeName);
      if (match) return match;
      if (required) {
        throw new BadRequestException(
          `Volume "${volumeName}" not found on the application. Available: ${claims.map((c) => c.name).join(', ') || 'none'}`,
        );
      }
    }
    if (claims.length === 1) return claims[0];
    if (required) {
      throw new BadRequestException(
        claims.length === 0
          ? 'The application has no volume to restore into'
          : `The application has several volumes; name one. Available: ${claims.map((c) => c.name).join(', ')}`,
      );
    }
    return undefined;
  }

  async deleteArchive(
    dest: BackupDestinationEntity,
    objectKeyPrefix: string,
  ): Promise<void> {
    const creds = this.destinations.toCredentials(dest);
    const backend = this.storage.forProvider(
      dest.provider as StorageBackendProvider,
    );
    // The archive's prefix is a full key, written at the bucket root.
    const root = { ...creds, pathPrefix: undefined };
    let cursor: string | undefined;
    do {
      const page = await backend.listObjects(
        root,
        `${stripTrailingSlashes(objectKeyPrefix)}/`,
        cursor,
      );
      if (page.keys.length) await backend.deleteObjects(root, page.keys);
      cursor = page.hasMore ? page.continuationToken : undefined;
    } while (cursor);
  }
}
