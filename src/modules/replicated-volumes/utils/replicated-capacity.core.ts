import type { V1CSIStorageCapacity } from '@kubernetes/client-node';
import { REPLICATED_STORAGE_CLASS } from '../replicated-volumes.constants';

const HOSTNAME_LABEL = 'kubernetes.io/hostname';

/**
 * The nodes for copies whose room the storage engine has not published yet.
 * The scheduler places a replicated volume only on a node with a published,
 * non-zero capacity, so until every node has one a new application is turned
 * away as if the cluster were full.
 */
export function nodesWithoutCapacity(
  capacities: readonly V1CSIStorageCapacity[],
  storageNodes: readonly string[],
): string[] {
  const published = new Set(
    capacities
      .filter(
        (c) =>
          c.storageClassName === REPLICATED_STORAGE_CLASS &&
          c.capacity !== undefined &&
          c.capacity !== '0',
      )
      .map((c) => c.nodeTopology?.matchLabels?.[HOSTNAME_LABEL])
      .filter((node): node is string => !!node),
  );
  return storageNodes.filter((node) => !published.has(node));
}
