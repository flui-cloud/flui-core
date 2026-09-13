import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageBackendProvider } from '../../../../storage/enums/storage-backend-provider.enum';
import {
  IObjectStoragePresetSource,
  ObjectStoragePreset,
  ObjectStorageRegionOption,
} from '../../../../storage/interfaces/object-storage-preset.interface';
import { ProvisionerCapability } from '../../../../storage/interfaces/object-storage-provisioner.interface';

const DEFAULT_ENDPOINT_TEMPLATE = 'https://s3.{region}.io.cloud.ovh.net';
const DEFAULT_REGION = 'gra';

/**
 * S3 region codes are lowercase and are NOT the Nova regions a cluster runs in
 * ('gra' here vs 'GRA11' for compute) — one is never derivable from the other.
 * Verified against the live endpoints on 2026-09-13: each of these accepted a
 * signed request.
 */
const REGIONS: readonly { code: string; city: string }[] = [
  { code: 'gra', city: 'Gravelines' },
  { code: 'sbg', city: 'Strasbourg' },
  { code: 'rbx', city: 'Roubaix' },
  { code: 'eu-west-par', city: 'Paris' },
  { code: 'de', city: 'Frankfurt' },
  { code: 'uk', city: 'London' },
  { code: 'waw', city: 'Warsaw' },
  { code: 'eu-south-mil', city: 'Milan' },
  { code: 'bhs', city: 'Beauharnois' },
  { code: 'ca-east-tor', city: 'Toronto' },
];

@Injectable()
export class OvhObjectStoragePreset implements IObjectStoragePresetSource {
  readonly provider = StorageBackendProvider.OVH_OBJECT_STORAGE;

  constructor(private readonly configService: ConfigService) {}

  /**
   * `OVH_S3_ENDPOINT_TEMPLATE` exists so a hostname change can be absorbed by
   * configuration rather than a release.
   */
  endpointFor(region: string): string {
    const template = this.configService.get<string>(
      'OVH_S3_ENDPOINT_TEMPLATE',
      DEFAULT_ENDPOINT_TEMPLATE,
    );
    return template.replace('{region}', region);
  }

  defaultRegion(): string {
    return this.configService.get<string>('OVH_S3_REGION', DEFAULT_REGION);
  }

  describe(): ObjectStoragePreset {
    const regions: ObjectStorageRegionOption[] = REGIONS.map((r) => ({
      value: r.code,
      label: `${r.city} (${r.code})`,
      endpoint: this.endpointFor(r.code),
    }));
    const defaultRegion = this.defaultRegion();
    return {
      provider: this.provider,
      label: 'OVHcloud Object Storage',
      badge: 'Free egress',
      description:
        'EU sovereignty (France / Germany / UK / Poland / Italy). Ingress and egress are free, which makes restores cost nothing to pull.',
      defaultRegion,
      defaultEndpoint: this.endpointFor(defaultRegion),
      forcePathStyle: true,
      usableForEtcdL1: true,
      provisioning: ProvisionerCapability.FULL_AUTO,
      regions,
    };
  }
}
