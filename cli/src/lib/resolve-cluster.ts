import { CliClusterRepository } from './repositories/cli-cluster.repository';
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { listClusters } from './cluster-listing';

export interface ResolvedCluster {
  id: string;
  name: string;
  entity: ClusterEntity;
}

export interface ClusterRef {
  id: string;
  name: string;
}

/**
 * Like {@link resolveCluster}, but also resolves workload clusters, which exist
 * only in the control cluster's database and never in this CLI's local store.
 * Returns the reference alone — callers needing the stored entity (kubeconfig,
 * K3s token, BYOS host) must use {@link resolveCluster}, which is local-only.
 */
export async function resolveClusterRef(
  clusterFlag?: string,
): Promise<ClusterRef> {
  const { clusters, apiError } = await listClusters();

  if (clusters.length === 0) {
    const why = apiError ? ` (API lookup failed: ${apiError})` : '';
    throw new Error(`No clusters found${why}. Run \`flui env create\` first.`);
  }

  if (clusterFlag) {
    const needle = clusterFlag.toLowerCase();
    const match = clusters.find(
      (c) => c.id === clusterFlag || c.name.toLowerCase() === needle,
    );
    if (!match) {
      const degraded = apiError
        ? `\nWorkload clusters could not be listed: ${apiError}`
        : '';
      throw new Error(
        `Cluster "${clusterFlag}" not found. Available clusters:\n` +
          clusters.map((c) => `  • ${c.name}  (${c.id})`).join('\n') +
          degraded,
      );
    }
    return { id: match.id, name: match.name };
  }

  if (clusters.length === 1) {
    return { id: clusters[0].id, name: clusters[0].name };
  }

  throw new Error(
    `Multiple clusters found. Specify one with --cluster <name-or-id>:\n` +
      clusters.map((c) => `  • ${c.name}  (${c.id})`).join('\n'),
  );
}

/**
 * Resolves which cluster to target for a CLI command.
 *
 * Resolution order:
 *   1. --cluster flag provided → match by ID or name (exact, case-insensitive)
 *   2. No flag + exactly 1 cluster stored locally → use it
 *   3. No flag + multiple clusters → error with list + hint
 *   4. No clusters at all → error asking to run `flui env create`
 */
export async function resolveCluster(
  clusterFlag?: string,
): Promise<ResolvedCluster> {
  const repo = new CliClusterRepository();
  const all = await repo.find();

  if (all.length === 0) {
    throw new Error('No clusters found locally. Run `flui env create` first.');
  }

  if (clusterFlag) {
    const needle = clusterFlag.toLowerCase();
    const match = all.find(
      (c) => c.id === clusterFlag || c.name.toLowerCase() === needle,
    );
    if (!match) {
      const list = all.map((c) => `  • ${c.name}  (${c.id})`).join('\n');
      throw new Error(
        `Cluster "${clusterFlag}" not found. Available clusters:\n${list}`,
      );
    }
    return { id: match.id, name: match.name, entity: match };
  }

  if (all.length === 1) {
    return { id: all[0].id, name: all[0].name, entity: all[0] };
  }

  const list = all.map((c) => `  • ${c.name}  (${c.id})`).join('\n');
  throw new Error(
    `Multiple clusters found. Specify one with --cluster <name-or-id>:\n${list}`,
  );
}
