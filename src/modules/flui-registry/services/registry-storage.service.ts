import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { GenericS3Backend } from '../../storage/implementations/generic-s3.backend';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { RegistryStorageEntity } from '../entities/registry-storage.entity';
import {
  FLUI_REGISTRY_CONFIG,
  FluiRegistryConfig,
} from '../flui-registry.config';
import { ScalewayRegistryStorageProvisioner } from '../provisioners/scaleway-registry-storage.provisioner';
import { RegistryObjectStorage } from '../registry-manifest';

export interface RegistryStorageInput {
  provider: StorageBackendProvider;
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  forcePathStyle?: boolean;
  accessKey: string;
  secretKey: string;
  providerResources?: Record<string, string>;
}

export interface RegistryStorageStatus {
  connected: boolean;
  provider?: StorageBackendProvider;
  endpoint?: string;
  region?: string;
  bucket?: string;
  connectedAt?: Date;
}

export interface RegistryBucket {
  id: string;
  provider: StorageBackendProvider;
  region: string;
  bucket: string;
  /** The one the registry is pointed at; the others were replaced. */
  active: boolean;
  /** Flui created it, and removes it with what it created around it. */
  createdByFlui: boolean;
  connectedAt: Date;
}

export interface RegistryBucketRemoval {
  bucket: string;
  /** False for a bucket of one's own: only Flui's record of it goes. */
  bucketDeleted: boolean;
}

/** Fixed monthly costs keep it out; Scaleway, OVH and a bucket of one's own are in. */
const REFUSED = new Set<StorageBackendProvider>([
  StorageBackendProvider.HETZNER_OBJECT_STORAGE,
]);

/**
 * The instance registry's bucket and its credential, sealed by the API. They
 * leave it decrypted in one place only: the registry's config Secret.
 */
@Injectable()
export class RegistryStorageService {
  private readonly logger = new Logger(RegistryStorageService.name);

  constructor(
    @InjectRepository(RegistryStorageEntity)
    private readonly rows: Repository<RegistryStorageEntity>,
    private readonly encryption: EncryptionService,
    private readonly s3: GenericS3Backend,
    private readonly scaleway: ScalewayRegistryStorageProvisioner,
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
  ) {}

  async connected(): Promise<{
    s3: RegistryObjectStorage;
    cachePassword: string;
  } | null> {
    const row = await this.rows.findOne({ where: { active: true } });
    if (!row) return null;
    return {
      s3: {
        endpoint: row.endpoint,
        region: row.region,
        bucket: row.bucket,
        prefix: row.prefix,
        forcePathStyle: row.forcePathStyle,
        accessKey: this.encryption.decrypt(row.accessKeyEncrypted),
        secretKey: this.encryption.decrypt(row.secretKeyEncrypted),
      },
      cachePassword: this.encryption.decrypt(row.cachePasswordEncrypted),
    };
  }

  async status(): Promise<RegistryStorageStatus> {
    const row = await this.rows.findOne({ where: { active: true } });
    if (!row) return { connected: false };
    return {
      connected: true,
      provider: row.provider,
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      connectedAt: row.createdAt,
    };
  }

  /**
   * Makes this bucket the registry's, once the credential has proved it can
   * write there. The bucket it replaces stays recorded, inactive, with what
   * Flui created for it, until that is taken down.
   */
  async connect(input: RegistryStorageInput): Promise<RegistryStorageStatus> {
    if (REFUSED.has(input.provider)) {
      throw new BadRequestException(
        `${input.provider} is not offered for the instance registry: use Scaleway, OVH or an S3-compatible bucket of your own`,
      );
    }
    const health = await this.s3.testConnection({
      provider: input.provider,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      accessKey: input.accessKey,
      secretKey: input.secretKey,
      forcePathStyle: input.forcePathStyle ?? false,
      pathPrefix: input.prefix ?? 'zot',
    });
    if (!health.healthy) {
      throw new BadRequestException(
        `The credential cannot write to ${input.bucket}: ${health.error ?? 'no detail'}`,
      );
    }
    await this.rows.update({ active: true }, { active: false });
    await this.rows.save(
      this.rows.create({
        provider: input.provider,
        endpoint: input.endpoint,
        region: input.region,
        bucket: input.bucket,
        prefix: input.prefix ?? 'zot',
        forcePathStyle: input.forcePathStyle ?? false,
        accessKeyEncrypted: this.encryption.encrypt(input.accessKey),
        secretKeyEncrypted: this.encryption.encrypt(input.secretKey),
        cachePasswordEncrypted: this.encryption.encrypt(
          randomBytes(24).toString('base64url'),
        ),
        providerResources: input.providerResources ?? {},
        active: true,
      }),
    );
    return this.status();
  }

  async list(): Promise<RegistryBucket[]> {
    const rows = await this.rows.find({ order: { createdAt: 'DESC' } });
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      region: row.region,
      bucket: row.bucket,
      active: row.active,
      createdByFlui: createdByFlui(row),
      connectedAt: row.createdAt,
    }));
  }

  /**
   * Forgets a bucket. One Flui created goes with its images and with the
   * project, key and policy made for it; one of the person's own stays as it
   * is. Images are never moved between buckets, so the one the registry
   * serves from cannot be removed.
   */
  async remove(id: string): Promise<RegistryBucketRemoval> {
    const row = await this.rows.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such registry bucket');
    if (row.active && this.config.storageBackend === 's3') {
      throw new ConflictException(
        'The registry keeps its images in this bucket: connect another one first',
      );
    }
    const bucketDeleted = createdByFlui(row);
    if (bucketDeleted) {
      const resources = row.providerResources ?? {};
      if (!resources.bucketDeletedAt) {
        await this.s3.emptyAndDeleteBucket({
          provider: row.provider,
          endpoint: row.endpoint,
          region: row.region,
          bucket: row.bucket,
          accessKey: this.encryption.decrypt(row.accessKeyEncrypted),
          secretKey: this.encryption.decrypt(row.secretKeyEncrypted),
          forcePathStyle: row.forcePathStyle,
        });
        row.providerResources = {
          ...resources,
          bucketDeletedAt: new Date().toISOString(),
        };
        await this.rows.save(row);
      }
      await this.scaleway.teardown(row.providerResources ?? {});
      this.logger.log(
        `Removed the registry bucket ${row.bucket} and what Flui created for it`,
      );
    }
    await this.rows.delete({ id: row.id });
    return { bucket: row.bucket, bucketDeleted };
  }
}

const createdByFlui = (row: RegistryStorageEntity): boolean =>
  row.provider === StorageBackendProvider.SCALEWAY_OBJECT_STORAGE &&
  Boolean(row.providerResources?.projectId);
