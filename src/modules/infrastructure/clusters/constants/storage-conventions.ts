/**
 * Storage conventions for Flui workload clusters.
 *
 * Architecture (decided 2026-05-10, see APPLICATION_SCALING_AND_RESOURCE_MANAGEMENT.md §14):
 *
 *   Master VM
 *   ├── nfs-kernel-server (NFSv4 export)
 *   └── Volume Flui-managed (provider block storage, attached, ext4)
 *       └── Mounted at FLUI_SHARED_STORAGE_PATH
 *
 *   Worker VM
 *   ├── cachefilesd (read-cache to local NVMe)
 *   └── NFS mount of master:FLUI_SHARED_STORAGE_PATH at the same path
 *
 *   local-path-provisioner is reconfigured to write to FLUI_SHARED_STORAGE_PATH
 *   on every node, so PVCs of catalog apps with `storageClassName=flui-shared`
 *   become subdirectories on the master's Volume — visible from any worker.
 */

/** Mountpoint on every node where the shared NFS volume lives. */
export const FLUI_SHARED_STORAGE_PATH = '/var/lib/flui/storage';

/** Local NVMe path on workers used by cachefilesd. */
export const FLUI_FSCACHE_PATH = '/var/cache/fscache';

/** Default size of the master's backing Volume in GB. */
export const FLUI_SHARED_VOLUME_DEFAULT_SIZE_GB = 20;

/**
 * Storage classes exposed by Flui to catalog manifests.
 * `flui-shared` is the default for non-database catalog apps.
 * `flui-dedicated` is for catalog apps that opt out of NFS (databases).
 * `flui-local` is the legacy/fallback path on bundled disk (no Flui-managed Volume).
 */
export enum FluiStorageClass {
  SHARED = 'flui-shared',
  DEDICATED = 'flui-dedicated',
  LOCAL = 'flui-local',
}

/** Filesystem label applied to the Flui-managed Volume by the bootstrap script. */
export const FLUI_SHARED_VOLUME_FS_LABEL = 'flui-data';

/** Default cache size on workers (GB) for cachefilesd. */
export const FLUI_FSCACHE_DEFAULT_SIZE_GB = 5;

/**
 * NFS export options used on the master.
 * - rw: writable from clients
 * - async: server doesn't fsync each write — drastically improves write IOPS,
 *   acceptable risk because the master also has the Volume locally and the
 *   catalog apps that go on shared storage are not write-critical (databases
 *   use `flui-dedicated` instead).
 * - no_subtree_check: speedup, standard for whole-volume exports.
 * - no_root_squash: K3s containerd runs as root inside containers — without
 *   this, file ownership inside containers becomes nobody:nogroup.
 */
export const NFS_EXPORT_OPTIONS = 'rw,async,no_subtree_check,no_root_squash';

/**
 * What the shared storage promises about a write it has confirmed, read off
 * the export options so the answer follows what the master actually runs.
 */
export function nfsDurability(exportOptions: string): {
  confirmsBeforeDisk: boolean;
  durability: string;
} {
  const confirmsBeforeDisk = exportOptions
    .split(',')
    .map((option) => option.trim())
    .includes('async');
  return {
    confirmsBeforeDisk,
    durability: confirmsBeforeDisk
      ? "Writes are confirmed before they reach the master's disk: if the master stops abruptly, the most recent ones can be lost. Keep databases on dedicated storage."
      : "Writes are confirmed once they are on the master's disk.",
  };
}

/**
 * NFS mount options used on workers.
 * - vers=4.2: full POSIX locking and modern features
 * - bg: keep retrying in background if master temporarily unreachable
 * - fsc: enable fscache
 * - async: client batches writes
 * - hard: block on outage rather than returning EIO (combined with bg)
 */
export const NFS_MOUNT_OPTIONS = 'vers=4.2,bg,fsc,async,hard,_netdev';
