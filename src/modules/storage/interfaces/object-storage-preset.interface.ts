import { StorageBackendProvider } from '../enums/storage-backend-provider.enum';
import { ProvisionerCapability } from './object-storage-provisioner.interface';

export interface ObjectStorageRegionOption {
  value: string;
  label: string;
  endpoint: string;
}

/** Everything a client needs to offer a backup destination without knowing any
 * provider's hostnames. */
export interface ObjectStoragePreset {
  provider: StorageBackendProvider;
  label: string;
  description: string;
  badge?: string;
  /** Absent for targets with no fixed home (MinIO, generic S3). */
  defaultRegion?: string;
  defaultEndpoint?: string;
  forcePathStyle: boolean;
  usableForEtcdL1: boolean;
  /** How much of the setup Flui can do by itself. */
  provisioning: ProvisionerCapability;
  regions?: ObjectStorageRegionOption[];
}

/**
 * A provider's own object-storage declaration. `endpointFor` is the one place
 * that knows the hostname shape, so the provisioner and the preset cannot
 * drift apart.
 */
export interface IObjectStoragePresetSource {
  readonly provider: StorageBackendProvider;
  endpointFor(region: string): string;
  describe(): ObjectStoragePreset;
}
