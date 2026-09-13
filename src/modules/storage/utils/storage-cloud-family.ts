import { StorageBackendProvider } from '../enums/storage-backend-provider.enum';

/**
 * The cloud a backup destination physically sits on, as a lowercase family name
 * comparable with `ClusterEntity.provider`. `null` means the target is opaque
 * (MinIO, generic S3): Flui cannot tell where it is hosted, so it cannot
 * promise the backup survives the loss of the cluster's own provider.
 */
export function cloudFamilyOfStorage(
  provider: StorageBackendProvider,
): string | null {
  switch (provider) {
    case StorageBackendProvider.SCALEWAY_OBJECT_STORAGE:
      return 'scaleway';
    case StorageBackendProvider.HETZNER_OBJECT_STORAGE:
      return 'hetzner';
    case StorageBackendProvider.OVH_OBJECT_STORAGE:
      return 'ovh';
    default:
      return null;
  }
}
