const GIB = 1024 ** 3;

export interface DiskSpace {
  totalGiB: number;
  freeGiB: number;
}

export interface NodeDisk {
  node: string;
  zone: string | null;
  /** The node's own disk, where `flui-local` keeps databases and dedicated data; null when it did not answer. */
  disk: DiskSpace | null;
  /** The space set aside for copies of replicated volumes; null on a node that holds none. */
  copies: DiskSpace | null;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The kubelet's `stats/summary`: the filesystem its root lives on. */
export function diskFromSummary(summary: unknown): DiskSpace | null {
  const fs = (summary as { node?: { fs?: Record<string, number> } })?.node?.fs;
  if (!fs?.capacityBytes || fs.availableBytes === undefined) return null;
  return {
    totalGiB: round(fs.capacityBytes / GIB),
    freeGiB: round(fs.availableBytes / GIB),
  };
}

/** `linstor -m --output-version v1 storage-pool list`, capacities in KiB, for one pool. */
export function copiesFromStoragePools(
  linstorJson: string,
  pool: string,
): Map<string, DiskSpace> {
  const parsed = JSON.parse(linstorJson) as unknown[];
  const rows = (Array.isArray(parsed[0]) ? parsed[0] : parsed) as Array<{
    storage_pool_name?: string;
    node_name?: string;
    free_capacity?: number;
    total_capacity?: number;
  }>;
  const byNode = new Map<string, DiskSpace>();
  for (const r of rows) {
    if (r.storage_pool_name !== pool || !r.node_name || !r.total_capacity) {
      continue;
    }
    byNode.set(r.node_name, {
      totalGiB: round(r.total_capacity / 1024 ** 2),
      freeGiB: round((r.free_capacity ?? 0) / 1024 ** 2),
    });
  }
  return byNode;
}

const LOW_SHARE = 0.15;
const LOW_DISK_GIB = 3;
const LOW_COPIES_GIB = 2;

const low = (space: DiskSpace, floorGiB: number) =>
  space.freeGiB < floorGiB || space.freeGiB < space.totalGiB * LOW_SHARE;

/** One sentence per node running short, on its disk or in its space for copies. */
export function diskWarnings(nodes: NodeDisk[]): string[] {
  const warnings: string[] = [];
  for (const n of nodes) {
    if (n.disk && low(n.disk, LOW_DISK_GIB)) {
      warnings.push(
        `${n.node} has ${n.disk.freeGiB} of ${n.disk.totalGiB} GiB free on its disk: databases and other data kept on the node stop growing when it is full.`,
      );
    }
    if (n.copies && low(n.copies, LOW_COPIES_GIB)) {
      warnings.push(
        `${n.node} has ${n.copies.freeGiB} of ${n.copies.totalGiB} GiB free for copies of replicated volumes: a new or larger replicated volume needs that room on both nodes holding its copies.`,
      );
    }
  }
  return warnings;
}
