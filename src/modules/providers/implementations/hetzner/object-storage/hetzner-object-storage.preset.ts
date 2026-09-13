import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageBackendProvider } from '../../../../storage/enums/storage-backend-provider.enum';
import {
  IObjectStoragePresetSource,
  ObjectStoragePreset,
} from '../../../../storage/interfaces/object-storage-preset.interface';
import { ProvisionerCapability } from '../../../../storage/interfaces/object-storage-provisioner.interface';

const DEFAULT_ENDPOINT_TEMPLATE = 'https://{region}.your-objectstorage.com';
const DEFAULT_REGION = 'nbg1';

const REGIONS: readonly { code: string; city: string }[] = [
  { code: 'nbg1', city: 'Nuremberg' },
  { code: 'fsn1', city: 'Falkenstein' },
  { code: 'hel1', city: 'Helsinki' },
];

@Injectable()
export class HetznerObjectStoragePreset implements IObjectStoragePresetSource {
  readonly provider = StorageBackendProvider.HETZNER_OBJECT_STORAGE;

  constructor(private readonly configService: ConfigService) {}

  endpointFor(region: string): string {
    const template = this.configService.get<string>(
      'HETZNER_S3_ENDPOINT_TEMPLATE',
      DEFAULT_ENDPOINT_TEMPLATE,
    );
    return template.replace('{region}', region);
  }

  defaultRegion(): string {
    return this.configService.get<string>('HETZNER_S3_REGION', DEFAULT_REGION);
  }

  describe(): ObjectStoragePreset {
    const defaultRegion = this.defaultRegion();
    return {
      provider: this.provider,
      label: 'Hetzner Object Storage',
      badge: 'Advanced only',
      description:
        'EU sovereignty (Germany / Finland). Object Storage keys must be connected separately before a bucket can be provisioned.',
      defaultRegion,
      defaultEndpoint: this.endpointFor(defaultRegion),
      forcePathStyle: true,
      usableForEtcdL1: true,
      provisioning: ProvisionerCapability.SEMI_AUTO,
      regions: REGIONS.map((r) => ({
        value: r.code,
        label: `${r.city} (${r.code})`,
        endpoint: this.endpointFor(r.code),
      })),
    };
  }
}
