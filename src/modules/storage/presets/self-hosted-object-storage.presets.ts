import { Injectable } from '@nestjs/common';
import { StorageBackendProvider } from '../enums/storage-backend-provider.enum';
import {
  IObjectStoragePresetSource,
  ObjectStoragePreset,
} from '../interfaces/object-storage-preset.interface';
import { ProvisionerCapability } from '../interfaces/object-storage-provisioner.interface';

/**
 * Targets with no cloud provider behind them, so no provider module to own
 * their declaration. Neither has a fixed hostname: the operator supplies one,
 * which is why both leave `defaultEndpoint` and `regions` empty rather than
 * suggesting something that would be wrong for every installation but one.
 */
@Injectable()
export class MinioObjectStoragePreset implements IObjectStoragePresetSource {
  readonly provider = StorageBackendProvider.MINIO;

  endpointFor(_region: string): string {
    throw new Error('MinIO endpoints are supplied by the operator');
  }

  describe(): ObjectStoragePreset {
    return {
      provider: this.provider,
      label: 'MinIO (self-hosted)',
      badge: 'Full sovereignty',
      description:
        'Your own infrastructure. Total data control, on your terms.',
      forcePathStyle: true,
      usableForEtcdL1: true,
      provisioning: ProvisionerCapability.NONE,
    };
  }
}

@Injectable()
export class GenericS3ObjectStoragePreset
  implements IObjectStoragePresetSource
{
  readonly provider = StorageBackendProvider.GENERIC_S3;

  endpointFor(_region: string): string {
    throw new Error('Generic S3 endpoints are supplied by the operator');
  }

  describe(): ObjectStoragePreset {
    return {
      provider: this.provider,
      label: 'Generic S3',
      description:
        'Any S3-compatible endpoint — AWS, Wasabi, Backblaze B2, Cloudflare R2, IDrive E2, MinIO server, …',
      forcePathStyle: true,
      usableForEtcdL1: false,
      provisioning: ProvisionerCapability.NONE,
    };
  }
}
