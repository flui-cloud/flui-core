import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import { CreateBackupDestinationDto } from '../dto/create-backup-destination.dto';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import {
  DestinationHealthStatus,
  EncryptionMode,
} from '../enums/destination-health.enum';
import { StorageBackendCredentials } from '../../storage/interfaces/backup-storage-backend.interface';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

@Injectable()
export class BackupDestinationsService {
  private readonly logger = new Logger(BackupDestinationsService.name);

  constructor(
    private readonly repo: BackupDestinationRepository,
    private readonly encryption: EncryptionService,
    private readonly storageFactory: StorageBackendFactory,
    @InjectRepository(BackupArtifactLocationEntity)
    private readonly locationRepo: Repository<BackupArtifactLocationEntity>,
  ) {}

  async create(
    userId: string,
    dto: CreateBackupDestinationDto,
  ): Promise<BackupDestinationEntity> {
    const accessKeyEncrypted = this.encryption.encrypt(dto.accessKey);
    const secretKeyEncrypted = this.encryption.encrypt(dto.secretKey);
    const encryptionMode = dto.encryptionMode ?? EncryptionMode.FLUI_MANAGED;
    let encryptionPassphraseEncrypted: string | undefined;
    if (encryptionMode === EncryptionMode.BYO_PASSPHRASE) {
      if (!dto.encryptionPassphrase) {
        throw new BadRequestException(
          'encryptionPassphrase required when encryptionMode=BYO_PASSPHRASE',
        );
      }
      encryptionPassphraseEncrypted = this.encryption.encrypt(
        dto.encryptionPassphrase,
      );
    } else if (encryptionMode === EncryptionMode.FLUI_MANAGED) {
      encryptionPassphraseEncrypted = this.encryption.encrypt(
        crypto.randomBytes(32).toString('hex'),
      );
    }

    const entity = this.repo.create({
      userId,
      name: dto.name,
      provider: dto.provider,
      endpoint: dto.endpoint,
      region: dto.region,
      bucket: dto.bucket,
      pathPrefix: dto.pathPrefix,
      accessKeyEncrypted,
      secretKeyEncrypted,
      encryptionMode,
      encryptionPassphraseEncrypted,
      forcePathStyle:
        dto.forcePathStyle ?? this.defaultForcePathStyle(dto.provider),
      useSse: dto.useSse ?? false,
      usableForEtcdL1:
        dto.usableForEtcdL1 ?? this.defaultEtcdL1Capable(dto.provider),
      costPerGbMonthCents: dto.costPerGbMonthCents,
      healthStatus: DestinationHealthStatus.UNKNOWN,
    });
    return this.repo.save(entity);
  }

  async list(userId: string): Promise<BackupDestinationEntity[]> {
    return this.repo.findByUser(userId);
  }

  async findById(id: string): Promise<BackupDestinationEntity> {
    const dest = await this.repo.findById(id);
    if (!dest) throw new NotFoundException(`BackupDestination ${id} not found`);
    return dest;
  }

  async testConnection(
    id: string,
  ): Promise<{ healthy: boolean; error?: string }> {
    const dest = await this.findById(id);
    const backend = this.storageFactory.forProvider(dest.provider);
    const creds = this.toCredentials(dest);
    const result = await backend.testConnection(creds);
    await this.repo.update(id, {
      healthStatus: result.healthy
        ? DestinationHealthStatus.HEALTHY
        : DestinationHealthStatus.FAILED,
      lastHealthCheckAt: new Date(),
      lastHealthError: result.error,
    });
    return { healthy: result.healthy, error: result.error };
  }

  async refreshUsage(id: string): Promise<void> {
    const dest = await this.findById(id);
    const backend = this.storageFactory.forProvider(dest.provider);
    const creds = this.toCredentials(dest);
    const usage = await backend.getUsage(creds);
    await this.repo.update(id, {
      usageBytes: String(usage.bytes),
      usageRefreshedAt: new Date(),
    });
  }

  /**
   * A destination still holding backups is refused, not deleted: removing it
   * is how the backups it points at stop being reachable.
   */
  async delete(id: string): Promise<void> {
    const held = await this.locationRepo.count({
      where: { destinationId: id },
    });
    if (held > 0) {
      throw new ConflictException(
        `This destination still holds ${held} backup${held === 1 ? '' : 's'}. Delete or expire them first — removing the destination now would leave them unreachable.`,
      );
    }
    await this.repo.delete(id);
  }

  toCredentials(dest: BackupDestinationEntity): StorageBackendCredentials {
    return {
      provider: dest.provider,
      endpoint: dest.endpoint,
      region: dest.region,
      bucket: dest.bucket,
      pathPrefix: dest.pathPrefix,
      forcePathStyle: dest.forcePathStyle,
      accessKey: this.encryption.decrypt(dest.accessKeyEncrypted),
      secretKey: this.encryption.decrypt(dest.secretKeyEncrypted),
    };
  }

  decryptPassphrase(dest: BackupDestinationEntity): string | undefined {
    if (!dest.encryptionPassphraseEncrypted) return undefined;
    return this.encryption.decrypt(dest.encryptionPassphraseEncrypted);
  }

  private defaultForcePathStyle(p: StorageBackendProvider): boolean {
    if (p === StorageBackendProvider.SCALEWAY_OBJECT_STORAGE) return false;
    return true;
  }

  private defaultEtcdL1Capable(p: StorageBackendProvider): boolean {
    return [
      StorageBackendProvider.HETZNER_OBJECT_STORAGE,
      StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
      StorageBackendProvider.OVH_OBJECT_STORAGE,
      StorageBackendProvider.MINIO,
    ].includes(p);
  }
}
