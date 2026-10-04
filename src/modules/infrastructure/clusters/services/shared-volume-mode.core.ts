/** Where a cluster's shared storage lives on every node: the master's disk, mounted by the others. */
export const SHARED_STORAGE_PATH = '/var/lib/flui/storage';

/** What K3s' own manifest writes when it restores its default storage settings. */
const K3S_DEFAULT_STORAGE_PATH = '/var/lib/rancher/k3s/storage';

/**
 * - `shared`: a volume can be used from any node, so an application whose node
 *   is lost starts again elsewhere with its data.
 * - `pinned`: a volume stays on the node that created it — the safe choice
 *   while some node does not see the shared storage, because a volume created
 *   there would otherwise sit on that node's own disk while claiming to be
 *   shared.
 */
export type SharedVolumeMode = 'shared' | 'pinned';

export type ObservedVolumeConfig = SharedVolumeMode | 'k3s-default' | 'custom';

export function localPathConfigFor(mode: SharedVolumeMode): string {
  const config =
    mode === 'shared'
      ? { sharedFileSystemPath: SHARED_STORAGE_PATH }
      : {
          nodePathMap: [
            {
              node: 'DEFAULT_PATH_FOR_NON_LISTED_NODES',
              paths: [SHARED_STORAGE_PATH],
            },
          ],
        };
  return JSON.stringify(config, null, 2);
}

/** Which of Flui's two settings the volume provisioner holds, if either. */
export function observedVolumeConfig(raw: string): ObservedVolumeConfig {
  let parsed: {
    sharedFileSystemPath?: string;
    nodePathMap?: Array<{ node?: string; paths?: string[] }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'custom';
  }
  if (parsed.sharedFileSystemPath === SHARED_STORAGE_PATH) return 'shared';
  const paths = (parsed.nodePathMap ?? []).flatMap(
    (entry) => entry.paths ?? [],
  );
  if (paths.length === 1 && paths[0] === SHARED_STORAGE_PATH) return 'pinned';
  if (paths.length === 1 && paths[0] === K3S_DEFAULT_STORAGE_PATH) {
    return 'k3s-default';
  }
  return 'custom';
}

export function desiredVolumeMode(
  nodesWithoutShare: string[],
): SharedVolumeMode {
  return nodesWithoutShare.length === 0 ? 'shared' : 'pinned';
}
