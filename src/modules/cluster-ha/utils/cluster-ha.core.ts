import {
  TOPOLOGY_REGION_LABEL,
  TOPOLOGY_ZONE_LABEL,
} from '../../providers/core/node-topology';
import {
  HaTopologyResolution,
  locationList,
} from '../../providers/core/ha-topology';

const CONTROL_PLANE_LABEL = 'node-role.kubernetes.io/control-plane';

export type ClusterHaLevel = 'standard' | 'three-locations';

export interface ClusterHaNode {
  name: string;
  zone?: string;
  region?: string;
  server: boolean;
  ready: boolean;
  /** Takes ordinary workloads: ready, not cordoned, no reserving taint. */
  schedulable: boolean;
}

export interface MissingRole {
  role: 'server' | 'data-host';
  zone: string;
  why: string;
}

export interface ClusterHaZone {
  zone: string;
  /** `data`: copies of data live here. `vote`: it only votes, a write never waits for it. */
  role: 'data' | 'vote';
  servers: string[];
  dataHosts: string[];
}

export interface ClusterHaState {
  level: ClusterHaLevel;
  region: string | null;
  /** The layout this cluster grows into; null when none applies, with the reason. */
  topology: { validated: boolean; zones: ClusterHaZone[] } | null;
  unsupported: string | null;
  servers: { count: number; ready: number; zones: string[] };
  survives: string[];
  doesNotSurvive: string[];
  warnings: string[];
  missing: MissingRole[];
}

interface NodeLike {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    unschedulable?: boolean;
    taints?: Array<{ key: string; effect: string }>;
  };
  status?: { conditions?: Array<{ type: string; status: string }> };
}

export function clusterHaNodesFrom(nodes: NodeLike[]): ClusterHaNode[] {
  return nodes
    .filter((n) => n.metadata?.name)
    .map((n) => {
      const ready = (n.status?.conditions ?? []).some(
        (c) => c.type === 'Ready' && c.status === 'True',
      );
      const reserved = (n.spec?.taints ?? []).some(
        (t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute',
      );
      return {
        name: n.metadata!.name!,
        zone: n.metadata?.labels?.[TOPOLOGY_ZONE_LABEL],
        region: n.metadata?.labels?.[TOPOLOGY_REGION_LABEL],
        server: n.metadata?.labels?.[CONTROL_PLANE_LABEL] === 'true',
        ready,
        schedulable: ready && !n.spec?.unschedulable && !reserved,
      };
    });
}

/** The region most of the cluster's nodes report. */
export function clusterHaRegion(nodes: ClusterHaNode[]): string | undefined {
  const count = new Map<string, number>();
  for (const n of nodes.filter((n) => n.region)) {
    count.set(n.region!, (count.get(n.region!) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function zonesWithServers(nodes: ClusterHaNode[]): string[] {
  return [
    ...new Set(nodes.filter((n) => n.server && n.zone).map((n) => n.zone!)),
  ].sort((a, b) => a.localeCompare(b));
}

/**
 * What a cluster survives with the nodes it has now, against the one layout
 * Flui offers: a server in each of three locations, copies of data in the
 * locations close enough to confirm a write together. Only what is there
 * counts; a role on its way does not raise the level until its node arrives.
 */
export function clusterHaState(
  nodes: ClusterHaNode[],
  resolution: HaTopologyResolution,
): ClusterHaState {
  const servers = nodes.filter((n) => n.server);
  const warnings: string[] = [];
  if (!nodes.some((n) => n.zone)) {
    warnings.push(
      'No node reports its location yet, so Flui cannot tell which locations the cluster spans.',
    );
  }
  if (servers.length === 2) {
    warnings.push(
      'Two servers are more fragile than one: losing either of them stops the control plane. A third server is needed.',
    );
  }
  const notReady = servers.filter((n) => !n.ready).map((n) => n.name);
  if (notReady.length) warnings.push(`Not ready: ${notReady.join(', ')}.`);

  const base = {
    region: clusterHaRegion(nodes) ?? null,
    servers: {
      count: servers.length,
      ready: servers.filter((n) => n.ready).length,
      zones: zonesWithServers(nodes),
    },
    warnings,
  };

  if (!resolution.topology) {
    return {
      ...base,
      level: 'standard',
      topology: null,
      unsupported: (resolution as { reason: string }).reason,
      ...standardSentences(servers.length),
      missing: [],
    };
  }

  const topology = resolution.topology;
  if (!topology.validated) {
    warnings.push(
      'This layout was forced: Flui has not measured how far apart these locations are.',
    );
  } else if (!topology.measured) {
    warnings.push(
      `The provider declares ${locationList(topology.zones)} as zones of one region, close together; Flui has not measured them yet.`,
    );
  }
  const zones: ClusterHaZone[] = topology.zones.map((zone) => ({
    zone,
    role: topology.dataZones.includes(zone) ? 'data' : 'vote',
    servers: servers
      .filter((n) => n.ready && n.zone === zone)
      .map((n) => n.name),
    dataHosts: topology.dataZones.includes(zone)
      ? nodes.filter((n) => n.schedulable && n.zone === zone).map((n) => n.name)
      : [],
  }));

  const missing: MissingRole[] = zones
    .filter((z) => z.servers.length === 0)
    .map((z) => ({
      role: 'server' as const,
      zone: z.zone,
      why: 'One server in each of the three locations keeps the cluster manageable when a location is lost.',
    }));
  const dataZonesWithHosts = zones.filter(
    (z) => z.role === 'data' && z.dataHosts.length > 0,
  );
  if (dataZonesWithHosts.length < topology.dataZones.length) {
    for (const z of zones.filter(
      (z) => z.role === 'data' && z.dataHosts.length === 0,
    )) {
      missing.push({
        role: 'data-host',
        zone: z.zone,
        why: `Copies of data live in ${locationList(topology.dataZones)}, one in each, on a node that takes applications.`,
      });
    }
  }

  const ready = missing.length === 0;
  return {
    ...base,
    level: ready ? 'three-locations' : 'standard',
    topology: { validated: topology.validated, zones },
    unsupported: null,
    ...(ready
      ? {
          survives: [
            'the loss of a server',
            'the loss of a whole location: the control plane, highly available databases and replicated volumes carry on in the other two',
          ],
          doesNotSurvive: ['the loss of two locations at once'],
        }
      : standardSentences(servers.length)),
    missing,
  };
}

function standardSentences(serverCount: number): {
  survives: string[];
  doesNotSurvive: string[];
} {
  return {
    survives: [
      'the loss of a worker, for applications with two or more copies',
    ],
    doesNotSurvive: [
      ...(serverCount >= 3
        ? []
        : [
            'the loss of the master: applications keep answering, but nothing can change and no copy can take over until it returns',
          ]),
      'the loss of the node a database or a volume lives on: it waits for the node or a restore',
      'the loss of a whole location',
    ],
  };
}
