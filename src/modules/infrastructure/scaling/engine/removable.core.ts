import {
  ClusterNodeEntity,
  NodeStatus,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';

/** A node the fleet could give back, named so something can actually remove it. */
export interface RemovableNode {
  id: string;
  name: string;
  hourlyEur: number | null;
}

/**
 * Which node the fleet gives back.
 *
 * The one a standing order named, when it named one. Otherwise the dearest
 * worker: coming back to the target is about the bill, and giving back the
 * cheapest machine of an oversized fleet is the version of this that costs
 * money to run. A group that spreads its nodes gives back from the region
 * holding the most of them first, so coming down keeps the fleet spread. Never
 * the master, and never a node already leaving. The preview a person reads
 * before saving asks the same function, so the two never name different
 * machines.
 */
export function pickRemovable(
  rows: ClusterNodeEntity[],
  named: string | null,
  spread = false,
): RemovableNode | null {
  const workers = rows.filter(
    (row) =>
      row.nodeType !== NodeType.MASTER && row.status !== NodeStatus.DELETING,
  );
  if (!workers.length) return null;

  const crowd = (row: ClusterNodeEntity) =>
    spread
      ? rows.filter(
          (other) =>
            other.status !== NodeStatus.DELETING && other.region === row.region,
        ).length
      : 0;
  const chosen =
    workers.find((row) => row.serverName === named || row.id === named) ??
    [...workers].sort(
      (a, b) =>
        crowd(b) - crowd(a) ||
        (b.hourlyPriceEur ?? -1) - (a.hourlyPriceEur ?? -1) ||
        a.serverName.localeCompare(b.serverName),
    )[0];

  return {
    id: chosen.id,
    name: chosen.serverName,
    hourlyEur: chosen.hourlyPriceEur ?? null,
  };
}
