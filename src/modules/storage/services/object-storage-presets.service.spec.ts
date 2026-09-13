import { ConfigService } from '@nestjs/config';
import { ObjectStoragePresetsService } from './object-storage-presets.service';
import { StorageBackendProvider } from '../enums/storage-backend-provider.enum';
import {
  GenericS3ObjectStoragePreset,
  MinioObjectStoragePreset,
} from '../presets/self-hosted-object-storage.presets';
import { OvhObjectStoragePreset } from '../../providers/implementations/ovh/object-storage/ovh-object-storage.preset';
import { ScalewayObjectStoragePreset } from '../../providers/implementations/scaleway/object-storage/scaleway-object-storage.preset';
import { HetznerObjectStoragePreset } from '../../providers/implementations/hetzner/object-storage/hetzner-object-storage.preset';

function configWith(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function build(config = configWith()) {
  return new ObjectStoragePresetsService([
    new ScalewayObjectStoragePreset(config),
    new OvhObjectStoragePreset(config),
    new HetznerObjectStoragePreset(config),
    new MinioObjectStoragePreset(),
    new GenericS3ObjectStoragePreset(),
  ]);
}

/**
 * The point of this catalogue is that no client holds a hostname of its own.
 * These check the API can actually answer that, for every provider a client
 * may be shown.
 */
describe('ObjectStoragePresetsService', () => {
  it('describes every destination a client can be offered', () => {
    const providers = build()
      .list()
      .map((p) => p.provider);

    expect(providers).toEqual([
      StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
      StorageBackendProvider.OVH_OBJECT_STORAGE,
      StorageBackendProvider.HETZNER_OBJECT_STORAGE,
      StorageBackendProvider.MINIO,
      StorageBackendProvider.GENERIC_S3,
    ]);
  });

  it('gives every managed provider a usable endpoint per region', () => {
    for (const preset of build().list()) {
      if (!preset.regions) continue;
      expect(preset.defaultEndpoint).toMatch(/^https:\/\//);
      for (const region of preset.regions) {
        expect(region.endpoint).toMatch(/^https:\/\//);
        expect(region.endpoint).toContain(region.value);
      }
      expect(preset.regions.map((r) => r.value)).toContain(
        preset.defaultRegion,
      );
    }
  });

  it('offers no endpoint for targets the operator hosts', () => {
    const selfHosted = build()
      .list()
      .filter((p) =>
        [
          StorageBackendProvider.MINIO,
          StorageBackendProvider.GENERIC_S3,
        ].includes(p.provider),
      );

    expect(selfHosted).toHaveLength(2);
    for (const preset of selfHosted) {
      expect(preset.defaultEndpoint).toBeUndefined();
      expect(preset.regions).toBeUndefined();
    }
  });

  it('absorbs a moved hostname from configuration, without a release', () => {
    const service = build(
      configWith({ OVH_S3_ENDPOINT_TEMPLATE: 'https://{region}.example.net' }),
    );

    const ovh = service.forProvider(StorageBackendProvider.OVH_OBJECT_STORAGE);

    expect(ovh?.defaultEndpoint).toBe('https://gra.example.net');
    expect(ovh?.regions?.[0].endpoint).toBe('https://gra.example.net');
  });

  it('keeps Scaleway on virtual-host addressing and the others on path style', () => {
    const service = build();

    expect(
      service.forProvider(StorageBackendProvider.SCALEWAY_OBJECT_STORAGE)
        ?.forcePathStyle,
    ).toBe(false);
    expect(
      service.forProvider(StorageBackendProvider.OVH_OBJECT_STORAGE)
        ?.forcePathStyle,
    ).toBe(true);
  });
});
