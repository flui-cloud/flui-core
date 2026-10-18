import {
  TopologyAppDto,
  TopologyClusterDto,
  TopologyClusterLinkDto,
  TopologyLinkDto,
} from '../dto/topology.dto';
import {
  TopologyEndpointKind,
  TopologyLinkSource,
  TopologyOverlay,
} from '../enums/topology.enums';
import {
  WorkloadReference,
  workloadNamesFor,
} from './topology-workload-refs.util';

/** `<slug>-svc.<namespace>.svc.cluster.local`, optionally with a port. */
const INTERNAL_HOST =
  /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-svc\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.svc\.cluster\.local(?::(\d{1,5}))?/g;

export interface InternalReference {
  slug: string;
  namespace: string;
  port: number | null;
}

/** Every internal host a value names. Only the parts that identify an app leave this function. */
export function internalReferences(value: string): InternalReference[] {
  return [...value.matchAll(INTERNAL_HOST)].map((m) => ({
    slug: m[1],
    namespace: m[2],
    port: m[3] ? Number(m[3]) : null,
  }));
}

/** A workload's configured in-cluster hosts, keyed by where the workload runs. */
export interface WorkloadRefs {
  namespace: string;
  name: string;
  refs: WorkloadReference[];
  clusterId?: string;
}

/**
 * Links from the hosts workloads' own configuration names: platform apps keep
 * theirs there, not on an application record. Resolved only to workloads on
 * the same cluster, so a public domain never becomes a link.
 */
export function workloadRefLinks(
  apps: TopologyAppDto[],
  refs: WorkloadRefs[],
): LinkCandidate[] {
  const at = new Map(
    apps.map((a) => [`${a.clusterId}|${a.namespace}|${a.name}`, a.id]),
  );
  return refs.flatMap((w) => {
    const from = at.get(`${w.clusterId}|${w.namespace}|${w.name}`);
    if (!from) return [];
    return w.refs.flatMap<LinkCandidate>((ref) => {
      const to = workloadNamesFor(ref.name)
        .map((n) => at.get(`${w.clusterId}|${ref.namespace}|${n}`))
        .find((id): id is string => !!id);
      return to && to !== from
        ? [
            {
              from,
              to,
              source: TopologyLinkSource.ENV_REFERENCE,
              port: ref.port,
            },
          ]
        : [];
    });
  });
}

export interface LinkCandidate {
  from: string | null;
  to: string;
  source: TopologyLinkSource;
  port?: number | null;
  routeHost?: string | null;
  routePath?: string | null;
  traffic?: { rps: number; errorPct: number | null } | null;
}

const STRENGTH: TopologyLinkSource[] = [
  TopologyLinkSource.GATEWAY_ROUTE,
  TopologyLinkSource.ATTACHED_SERVICE,
  TopologyLinkSource.CATALOG_DEPENDENCY,
  TopologyLinkSource.ENV_REFERENCE,
];

/**
 * One link per pair, from the strongest source that declares it. Links to or
 * from apps the snapshot does not hold, and an app pointing at itself, are
 * dropped.
 */
export function assembleLinks(
  candidates: LinkCandidate[],
  apps: TopologyAppDto[],
  clusters: TopologyClusterDto[],
): { links: TopologyLinkDto[]; clusterLinks: TopologyClusterLinkDto[] } {
  const app = new Map(apps.map((a) => [a.id, a]));
  const tunnel = new Set(
    clusters
      .filter((c) => c.overlay === TopologyOverlay.TUNNEL)
      .map((c) => c.id),
  );
  const strongest = new Map<string, LinkCandidate>();
  for (const c of candidates) {
    if (!app.has(c.to) || (c.from && !app.has(c.from)) || c.from === c.to)
      continue;
    const key = `${c.from ?? 'internet'}>${c.to}`;
    const held = strongest.get(key);
    if (!held || STRENGTH.indexOf(c.source) < STRENGTH.indexOf(held.source)) {
      strongest.set(key, c);
    }
  }

  const links = [...strongest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map<TopologyLinkDto>(([key, c]) => {
      const fromCluster = c.from ? app.get(c.from)!.clusterId : null;
      const toCluster = app.get(c.to)!.clusterId;
      const crossCluster = !!fromCluster && fromCluster !== toCluster;
      return {
        id: key,
        from: c.from
          ? { kind: TopologyEndpointKind.APP, appId: c.from }
          : { kind: TopologyEndpointKind.INTERNET },
        to: { kind: TopologyEndpointKind.APP, appId: c.to },
        source: c.source,
        label: labelOf(c),
        crossCluster,
        viaTunnel:
          crossCluster && tunnel.has(fromCluster) && tunnel.has(toCluster),
        routeHost: c.routeHost ?? null,
        routePath: c.routePath ?? null,
        targetPort: c.from ? null : (c.port ?? null),
        traffic: c.traffic
          ? { measured: true, rps: c.traffic.rps, errorPct: c.traffic.errorPct }
          : { measured: false, rps: null, errorPct: null },
      };
    });

  const pairs = new Map<string, TopologyClusterLinkDto>();
  for (const link of links.filter((l) => l.crossCluster)) {
    const from = app.get(link.from.appId!)!.clusterId;
    const to = app.get(link.to.appId!)!.clusterId;
    const pair = pairs.get(`${from}>${to}`) ?? {
      fromClusterId: from,
      toClusterId: to,
      linkCount: 0,
      rps: null,
      viaTunnel: link.viaTunnel,
    };
    pair.linkCount += 1;
    pairs.set(`${from}>${to}`, pair);
  }

  return { links, clusterLinks: [...pairs.values()] };
}

function labelOf(c: LinkCandidate): string {
  if (!c.from) return 'HTTPS';
  return c.port ? `:${c.port}` : 'TCP';
}
