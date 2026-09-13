import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageBackendProvider } from '../../../../storage/enums/storage-backend-provider.enum';
import {
  IObjectStoragePresetSource,
  ObjectStoragePreset,
} from '../../../../storage/interfaces/object-storage-preset.interface';
import { ProvisionerCapability } from '../../../../storage/interfaces/object-storage-provisioner.interface';

const DEFAULT_ENDPOINT_TEMPLATE = 'https://s3.{region}.scw.cloud';
const DEFAULT_REGION = 'fr-par';

const REGIONS: readonly { code: string; city: string }[] = [
  { code: 'fr-par', city: 'Paris' },
  { code: 'nl-ams', city: 'Amsterdam' },
  { code: 'pl-waw', city: 'Warsaw' },
];

@Injectable()
export class ScalewayObjectStoragePreset implements IObjectStoragePresetSource {
  readonly provider = StorageBackendProvider.SCALEWAY_OBJECT_STORAGE;

  constructor(private readonly configService: ConfigService) {}

  endpointFor(region: string): string {
    const template = this.configService.get<string>(
      'SCALEWAY_S3_ENDPOINT_TEMPLATE',
      DEFAULT_ENDPOINT_TEMPLATE,
    );
    return template.replace('{region}', region);
  }

  defaultRegion(): string {
    return this.configService.get<string>('SCALEWAY_S3_REGION', DEFAULT_REGION);
  }

  describe(): ObjectStoragePreset {
    const defaultRegion = this.defaultRegion();
    return {
      provider: this.provider,
      label: 'Scaleway Object Storage',
      badge: 'Recommended primary',
      description:
        'EU sovereignty (France / Netherlands / Poland). Default Object Storage for app-level backups.',
      defaultRegion,
      defaultEndpoint: this.endpointFor(defaultRegion),
      forcePathStyle: false,
      usableForEtcdL1: true,
      provisioning: ProvisionerCapability.FULL_AUTO,
      regions: REGIONS.map((r) => ({
        value: r.code,
        label: `${r.city} (${r.code})`,
        endpoint: this.endpointFor(r.code),
      })),
    };
  }
}
