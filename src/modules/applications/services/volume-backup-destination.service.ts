import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BackupDestinationEntity } from '../../backups/entities/backup-destination.entity';
import { ObjectStorageProvisionerFactory } from '../../storage/factories/object-storage-provisioner.factory';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { BackupDestination, ResolvedDestination } from './volume-backups.types';

@Injectable()
export class VolumeBackupDestinationService {
  constructor(
    @InjectRepository(BackupDestinationEntity)
    private readonly destinationRepository: Repository<BackupDestinationEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly objectStorageProvisionerFactory: ObjectStorageProvisionerFactory,
  ) {}

  /**
   * If the caller passed an explicit destination, use it. Otherwise auto-
   * provision via the matching object-storage provisioner. This requires
   * the cluster provider's compute credentials to be configured (Scaleway:
   * the same key powers Object Storage; Hetzner: separate Object Storage
   * key required).
   */
  async resolve(
    explicit: BackupDestination | undefined,
    destinationId: string | undefined,
    cloudProvider: CloudProvider,
    clusterId: string,
    userId: string | undefined,
  ): Promise<ResolvedDestination> {
    if (explicit) return explicit;

    // A registered destination is the good path: its credentials are already
    // encrypted at rest, and the copy ends up linked to it in the ledger
    // instead of pointing at a bucket nothing else knows about.
    if (destinationId) {
      const dest = await this.destinationRepository.findOne({
        where: { id: destinationId },
      });
      if (!dest) {
        throw new NotFoundException(
          `Backup destination ${destinationId} not found`,
        );
      }
      return {
        bucket: dest.bucket,
        endpoint: dest.endpoint,
        region: dest.region,
        accessKeyId: this.encryptionService.decrypt(dest.accessKeyEncrypted),
        secretAccessKey: this.encryptionService.decrypt(
          dest.secretKeyEncrypted,
        ),
        keyPrefix: dest.pathPrefix,
        registered: dest,
      };
    }

    const storageProvider = this.cloudToStorageProvider(cloudProvider);
    if (!storageProvider) {
      throw new BadRequestException(
        `No object-storage provisioner available for provider=${cloudProvider}; ` +
          `pass an explicit destination instead`,
      );
    }
    const provisioner =
      this.objectStorageProvisionerFactory.forProvider(storageProvider);
    if (!provisioner) {
      throw new BadRequestException(
        `Object-storage provisioner not registered for ${storageProvider}; ` +
          `pass an explicit destination instead`,
      );
    }
    if (!userId) {
      throw new BadRequestException(
        'userId is required to auto-provision a backup destination',
      );
    }
    const readiness = await provisioner.isReady(userId);
    if (!readiness.ready) {
      throw new BadRequestException(
        readiness.message ??
          `Object-storage provisioner not ready (${readiness.reason ?? 'unknown'})`,
      );
    }
    const result = await provisioner.provisionDestination({
      userId,
      clusterId,
    });
    return {
      bucket: result.bucket,
      endpoint: result.endpoint,
      region: result.region,
      accessKeyId: result.accessKey,
      secretAccessKey: result.secretKey,
      keyPrefix: result.pathPrefix,
    };
  }

  private cloudToStorageProvider(
    cloudProvider: CloudProvider,
  ): StorageBackendProvider | null {
    switch (cloudProvider) {
      case CloudProvider.SCALEWAY:
        return StorageBackendProvider.SCALEWAY_OBJECT_STORAGE;
      case CloudProvider.HETZNER:
        return StorageBackendProvider.HETZNER_OBJECT_STORAGE;
      default:
        return null;
    }
  }
}
