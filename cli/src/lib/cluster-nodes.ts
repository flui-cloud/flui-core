import { ApiClient } from './api-client';

/**
 * The subset of `GET /infrastructure/clusters/:id/nodes` these commands need.
 * The route projects the entity explicitly, so this is the whole contract.
 */
export interface ClusterNodeSummary {
  id: string;
  serverName: string;
  nodeType: string;
  ipAddress?: string;
  status?: string;
}

/**
 * Resolve `master` or a serverName to the node id the per-node routes take.
 *
 * The commands that used to do this read `~/.flui/nodes.json`. Asking the API
 * instead is not only where the guard is — it is also the store that the routes
 * themselves act on, so a name that resolves here is a name the following call
 * will accept, and a drift between the two stores surfaces as a clear "not
 * found" rather than as a 404 halfway through a scale.
 */
export async function findClusterNode(
  api: ApiClient,
  clusterId: string,
  target: string,
): Promise<ClusterNodeSummary> {
  const nodes = await api.get<ClusterNodeSummary[]>(
    `/infrastructure/clusters/${clusterId}/nodes`,
  );
  const match =
    target === 'master'
      ? nodes.find((n) => n.nodeType === 'master')
      : nodes.find((n) => n.serverName === target);
  if (!match) {
    const known = nodes.map((n) => `  • ${n.serverName} (${n.nodeType})`);
    throw new Error(
      `Node "${target}" not found on this cluster.` +
        (known.length ? `\n\nKnown nodes:\n${known.join('\n')}` : ''),
    );
  }
  return match;
}
