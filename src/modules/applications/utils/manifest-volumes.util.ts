import { REPLICATED_STORAGE_CLASS } from '../../replicated-volumes/replicated-volumes.constants';
import { ApplicationVolume } from '../interfaces/source-config.interface';

export interface ManifestVolumeInput {
  name: string;
  mountPath: string;
  size?: string;
  replicated?: boolean;
}

export interface VolumeReplicationMismatch {
  name: string;
  declared: boolean;
}

/** `replicated: true` is the replicated storage class; every other volume keeps the cluster's default. */
export function appVolumesFromManifest(
  volumes: readonly ManifestVolumeInput[] | undefined,
): ApplicationVolume[] {
  return (volumes ?? []).map(({ name, mountPath, size, replicated }) => ({
    name,
    mountPath,
    ...(size ? { size } : {}),
    ...(replicated ? { storageClass: REPLICATED_STORAGE_CLASS } : {}),
  }));
}

export function declaresReplicatedVolume(
  volumes: readonly ManifestVolumeInput[] | undefined,
): boolean {
  return (volumes ?? []).some((v) => v.replicated === true);
}

/**
 * A volume's storage is chosen when the volume is created and a redeploy never
 * moves its data, so a manifest that now says otherwise about a volume the
 * application already has would describe storage that is not the one running.
 */
export function volumeReplicationMismatches(
  declared: readonly ManifestVolumeInput[] | undefined,
  existing: readonly ApplicationVolume[] | undefined,
): VolumeReplicationMismatch[] {
  const actual = new Map(
    (existing ?? []).map((v) => [
      v.name,
      v.storageClass === REPLICATED_STORAGE_CLASS,
    ]),
  );
  return (declared ?? [])
    .filter(
      (v) =>
        actual.has(v.name) && actual.get(v.name) !== (v.replicated === true),
    )
    .map((v) => ({ name: v.name, declared: v.replicated === true }));
}
