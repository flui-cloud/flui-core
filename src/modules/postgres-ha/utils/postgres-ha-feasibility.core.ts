import { HaTopology } from '../../providers/core/ha-topology';
import { TOPOLOGY_ZONE_LABEL } from '../../providers/core/node-topology';

export interface HaCandidateNode {
  name: string;
  zone?: string;
  schedulable: boolean;
}

export type PostgresHaFeasibility =
  | { feasible: true }
  | { feasible: false; reason: string };

/**
 * Whether a cluster can hold a highly available Postgres: one instance in each
 * of the layout's three locations, on a node that takes workloads. A request
 * it cannot honour is refused with the reason, never placed on fewer
 * locations than it needs.
 */
export function postgresHaFeasibility(
  nodes: HaCandidateNode[],
  topology: HaTopology,
): PostgresHaFeasibility {
  const missing = topology.zones.filter(
    (zone) => !nodes.some((n) => n.schedulable && n.zone === zone),
  );
  if (missing.length) {
    return {
      feasible: false,
      reason: `A highly available Postgres keeps one instance in each of ${topology.zones.join(', ')}; ${missing.join(' and ')} ${missing.length === 1 ? 'has' : 'have'} no node that takes workloads.`,
    };
  }
  return { feasible: true };
}

interface NodeLike {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    unschedulable?: boolean;
    taints?: Array<{ key: string; effect: string }>;
  };
  status?: { conditions?: Array<{ type: string; status: string }> };
}

/** A node counts when it is ready, not cordoned and takes ordinary workloads. */
export function haCandidatesFrom(nodes: NodeLike[]): HaCandidateNode[] {
  return nodes
    .filter((node) => node.metadata?.name)
    .map((node) => {
      const ready = (node.status?.conditions ?? []).some(
        (c) => c.type === 'Ready' && c.status === 'True',
      );
      const reserved = (node.spec?.taints ?? []).some(
        (t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute',
      );
      return {
        name: node.metadata!.name!,
        zone: node.metadata?.labels?.[TOPOLOGY_ZONE_LABEL],
        schedulable: ready && !node.spec?.unschedulable && !reserved,
      };
    });
}
