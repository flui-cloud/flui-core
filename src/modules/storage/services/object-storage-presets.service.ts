import { Injectable } from '@nestjs/common';
import { StorageBackendProvider } from '../enums/storage-backend-provider.enum';
import {
  IObjectStoragePresetSource,
  ObjectStoragePreset,
} from '../interfaces/object-storage-preset.interface';

/** Order clients present them in: managed EU providers first, self-hosted last. */
const DISPLAY_ORDER: readonly StorageBackendProvider[] = [
  StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
  StorageBackendProvider.OVH_OBJECT_STORAGE,
  StorageBackendProvider.HETZNER_OBJECT_STORAGE,
  StorageBackendProvider.MINIO,
  StorageBackendProvider.GENERIC_S3,
];

function rank(provider: StorageBackendProvider): number {
  const i = DISPLAY_ORDER.indexOf(provider);
  return i < 0 ? DISPLAY_ORDER.length : i;
}

/**
 * The catalogue of backup destinations the API offers, assembled from each
 * provider's own declaration. Clients render what this returns and hold no
 * hostnames of their own — the day a provider moves an endpoint, one
 * declaration changes and every surface follows.
 */
@Injectable()
export class ObjectStoragePresetsService {
  private readonly sources = new Map<
    StorageBackendProvider,
    IObjectStoragePresetSource
  >();

  constructor(sources: IObjectStoragePresetSource[]) {
    for (const s of sources) this.sources.set(s.provider, s);
  }

  list(): ObjectStoragePreset[] {
    return [...this.sources.values()]
      .map((s) => s.describe())
      .sort((a, b) => rank(a.provider) - rank(b.provider));
  }

  forProvider(
    provider: StorageBackendProvider,
  ): ObjectStoragePreset | undefined {
    return this.sources.get(provider)?.describe();
  }
}
