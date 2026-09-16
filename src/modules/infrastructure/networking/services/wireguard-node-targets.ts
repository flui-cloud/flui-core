import { Logger } from '@nestjs/common';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../../clusters/entities/cluster-node.entity';
import {
  HostTarget,
  deriveHostTargets,
} from '../../../providers/core/host/host-targets';

/**
 * Lines up nodes with the SSH endpoints derived for the cluster.
 *
 * `deriveHostTargets` answers per cluster, not per node, so the two are matched
 * on host address. A node with no matching endpoint is skipped rather than
 * guessed at: applying it on the wrong machine would give that machine another
 * node's identity on the overlay.
 */
export function pairNodesWithTargets(
  cluster: ClusterEntity,
  logger: Logger,
): Array<{ node: ClusterNodeEntity; target: HostTarget }> {
  const targets = deriveHostTargets(cluster);
  const byHost = new Map(targets.map((t) => [t.host, t]));
  const paired: Array<{ node: ClusterNodeEntity; target: HostTarget }> = [];
  for (const node of cluster.nodes ?? []) {
    const byosHost = (node.metadata as { byos?: { host?: string } } | undefined)
      ?.byos?.host;
    const target =
      (byosHost && byHost.get(byosHost)) ||
      (node.ipAddress ? byHost.get(node.ipAddress) : undefined);
    if (!target) {
      logger.warn(
        `[wg] node ${node.serverName ?? node.id} has no SSH endpoint among the cluster's — skipping`,
      );
      continue;
    }
    paired.push({ node, target });
  }
  return paired;
}
