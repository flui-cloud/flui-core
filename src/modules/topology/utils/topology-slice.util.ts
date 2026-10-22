import type {
  TopologyAppDto,
  TopologyClusterDto,
  TopologyLinkDto,
  TopologyResponseDto,
  TopologyServerDto,
} from '../dto/topology.dto';
import {
  TopologyAppKind,
  TopologyAppStatus,
  TopologyEndpointKind,
  TopologyHealthStatus,
  TopologyOverlay,
} from '../enums/topology.enums';

/**
 * Reading one snapshot the way the dashboard's Topology reads it: finding a
 * cluster, an app or a server by what a person types, cutting the snapshot
 * down to what concerns it, and the list of what needs attention. Shared by
 * the CLI and the MCP tool so the terminal, an agent and the map tell the same
 * story.
 */

type Snapshot = TopologyResponseDto;

export type TopologyMatch<T> = { found: T } | { candidates: T[] };

const same = (a: string | null | undefined, b: string) =>
  !!a && a.toLowerCase() === b.toLowerCase();

function match<T>(
  items: T[],
  ref: string,
  id: (item: T) => string,
  names: (item: T) => Array<string | null | undefined>,
): TopologyMatch<T> {
  const byId = items.find((item) => id(item) === ref);
  if (byId) return { found: byId };
  const named = items.filter((item) => names(item).some((n) => same(n, ref)));
  return named.length === 1 ? { found: named[0] } : { candidates: named };
}

export function findCluster(
  t: Snapshot,
  ref: string,
): TopologyMatch<TopologyClusterDto> {
  return match(
    t.clusters,
    ref,
    (c) => c.id,
    (c) => [c.name, c.displayName],
  );
}

/** Narrowed to one cluster when `clusterRef` names one; undefined when it names none. */
function inCluster<T extends { clusterId: string }>(
  t: Snapshot,
  items: T[],
  clusterRef: string | undefined,
): T[] | undefined {
  if (!clusterRef) return items;
  const cluster = findCluster(t, clusterRef);
  if (!('found' in cluster)) return undefined;
  return items.filter((item) => item.clusterId === cluster.found.id);
}

export function findApp(
  t: Snapshot,
  ref: string,
  clusterRef?: string,
): TopologyMatch<TopologyAppDto> {
  const apps = inCluster(t, t.apps, clusterRef);
  if (!apps) return { candidates: [] };
  return match(
    apps,
    ref,
    (a) => a.id,
    (a) => [a.name, a.displayName, a.slug],
  );
}

export function findServer(
  t: Snapshot,
  ref: string,
  clusterRef?: string,
): TopologyMatch<TopologyServerDto> {
  const servers = inCluster(t, t.servers, clusterRef);
  if (!servers) return { candidates: [] };
  return match(
    servers,
    ref,
    (s) => s.id,
    (s) => [s.nodeName],
  );
}

export const clusterNameOf = (t: Snapshot, id: string): string =>
  t.clusters.find((c) => c.id === id)?.name ?? '';

const LISTED = 12;

function listOf(names: string[]): string {
  const shown = names.slice(0, LISTED).join(', ');
  return names.length > LISTED
    ? `${shown} and ${names.length - LISTED} more`
    : shown;
}

/** Why a name did not resolve to one thing, with what it could have been. */
export function missMessage(
  t: Snapshot,
  kind: 'cluster' | 'app' | 'server',
  ref: string,
  candidates: Array<TopologyClusterDto | TopologyAppDto | TopologyServerDto>,
  clusterRef?: string,
): string {
  if (
    clusterRef &&
    kind !== 'cluster' &&
    !('found' in findCluster(t, clusterRef))
  ) {
    return `No cluster named "${clusterRef}". Clusters: ${listOf(t.clusters.map((c) => c.name))}.`;
  }
  if (candidates.length > 1) {
    const rows = candidates.map((c) => {
      if ('nodeName' in c)
        return [c.nodeName, clusterNameOf(t, c.clusterId), c.id];
      if ('clusterId' in c)
        return [c.displayName, clusterNameOf(t, c.clusterId), c.id];
      return [c.name, '', c.id];
    });
    const widths = [0, 1].map((i) => Math.max(...rows.map((r) => r[i].length)));
    const lines = rows.map((r) =>
      `  ${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2]}`.trimEnd(),
    );
    const narrow = kind === 'cluster' ? 'the id' : '--cluster or the id';
    return `"${ref}" matches ${candidates.length} ${kind}s:\n${lines.join('\n')}\nPass ${narrow} to choose one.`;
  }
  const names = {
    cluster: () => t.clusters.map((c) => c.name),
    app: () => t.apps.map((a) => a.name),
    server: () => t.servers.map((s) => s.nodeName),
  }[kind]();
  const where = clusterRef ? ` on ${clusterRef}` : '';
  return `No ${kind} named "${ref}"${where}. ${kind[0].toUpperCase()}${kind.slice(1)}s: ${listOf([...new Set(names)]) || 'none'}.`;
}

export const isSystem = (a: Pick<TopologyAppDto, 'kind'>) =>
  a.kind === TopologyAppKind.SYSTEM;

export const isTroubled = (a: Pick<TopologyAppDto, 'status'>) =>
  a.status === TopologyAppStatus.ERROR ||
  a.status === TopologyAppStatus.WARNING;

const fromInternet = (l: TopologyLinkDto) =>
  l.from.kind === TopologyEndpointKind.INTERNET;

/** Routes from the Internet to an app. */
export const routesTo = (t: Snapshot, appId: string): TopologyLinkDto[] =>
  t.links.filter((l) => fromInternet(l) && l.to.appId === appId);

/** Requests per second reaching an app from the Internet; null when nothing is measured. */
export function trafficIn(t: Snapshot, appId: string): number | null {
  const measured = routesTo(t, appId).filter(
    (l) => l.traffic.measured && l.traffic.rps !== null,
  );
  return measured.length
    ? measured.reduce((sum, l) => sum + (l.traffic.rps ?? 0), 0)
    : null;
}

export const callersOf = (t: Snapshot, appId: string) =>
  t.links.filter(
    (l) => !fromInternet(l) && l.to.appId === appId && l.from.appId,
  );

export const calleesOf = (t: Snapshot, appId: string) =>
  t.links.filter((l) => l.from.appId === appId && l.to.appId);

export const appsOnServer = (t: Snapshot, serverId: string) =>
  t.apps.filter((a) => a.replicas.some((r) => r.serverId === serverId));

const SEVERITY = [
  TopologyAppStatus.ERROR,
  TopologyAppStatus.WARNING,
  TopologyAppStatus.STOPPED,
];

export function worstAppStatus(apps: TopologyAppDto[]): TopologyAppStatus {
  return (
    SEVERITY.find((s) => apps.some((a) => a.status === s)) ??
    TopologyAppStatus.RUNNING
  );
}

export function clusterSlice(t: Snapshot, clusterId: string) {
  const apps = t.apps.filter((a) => a.clusterId === clusterId);
  const ids = new Set(apps.map((a) => a.id));
  const projectIds = new Set(apps.map((a) => a.projectId));
  return {
    cluster: t.clusters.find((c) => c.id === clusterId) ?? null,
    servers: t.servers.filter((s) => s.clusterId === clusterId),
    stacks: t.stacks.filter((s) => s.clusterId === clusterId),
    apps,
    links: t.links.filter(
      (l) => ids.has(l.to.appId ?? '') || ids.has(l.from.appId ?? ''),
    ),
    projects: (t.projects ?? []).filter((p) => projectIds.has(p.id)),
  };
}

export function appSlice(t: Snapshot, appId: string) {
  const app = t.apps.find((a) => a.id === appId) ?? null;
  const links = t.links.filter(
    (l) => l.to.appId === appId || l.from.appId === appId,
  );
  const peerIds = new Set(
    links
      .flatMap((l) => [l.from.appId, l.to.appId])
      .filter((id) => id && id !== appId),
  );
  const serverIds = new Set(app?.replicas.map((r) => r.serverId) ?? []);
  return {
    app,
    cluster: t.clusters.find((c) => c.id === app?.clusterId) ?? null,
    stack: t.stacks.find((s) => s.id === app?.stackId) ?? null,
    project: (t.projects ?? []).find((p) => p.id === app?.projectId) ?? null,
    servers: t.servers.filter((s) => serverIds.has(s.id)),
    links,
    peers: t.apps.filter((a) => peerIds.has(a.id)),
  };
}

export function serverSlice(t: Snapshot, serverId: string) {
  const server = t.servers.find((s) => s.id === serverId) ?? null;
  return {
    server,
    cluster: t.clusters.find((c) => c.id === server?.clusterId) ?? null,
    apps: appsOnServer(t, serverId),
  };
}

export const FULL_MEMORY_PCT = 90;

export interface TopologyAttention {
  type: 'cluster' | 'app' | 'server';
  id: string;
  label: string;
  detail: string;
  severity: 'error' | 'warning';
}

/** What the fleet asks of a person right now, in the dashboard's order. */
export function attentionOf(t: Snapshot): TopologyAttention[] {
  const severity = (a: TopologyAppDto) =>
    a.status === TopologyAppStatus.ERROR ? 0 : 1;
  return [
    ...t.clusters
      .filter((c) => c.status === TopologyHealthStatus.DOWN)
      .map((c) => ({
        type: 'cluster' as const,
        id: c.id,
        label: c.name,
        detail: 'Not answering',
        severity: 'error' as const,
      })),
    ...t.apps
      .filter(isTroubled)
      .sort((a, b) => severity(a) - severity(b))
      .map((a) => ({
        type: 'app' as const,
        id: a.id,
        label: a.displayName,
        detail:
          a.statusReason ??
          (a.status === TopologyAppStatus.ERROR ? 'Error' : 'Warning'),
        severity:
          a.status === TopologyAppStatus.ERROR
            ? ('error' as const)
            : ('warning' as const),
      })),
    ...t.servers
      .filter((s) => (s.capacity?.usedMemPct ?? 0) >= FULL_MEMORY_PCT)
      .map((s) => ({
        type: 'server' as const,
        id: s.id,
        label: s.nodeName,
        detail: `Memory ${Math.round(s.capacity?.usedMemPct ?? 0)}%`,
        severity: 'error' as const,
      })),
    ...t.clusters
      .filter((c) => c.overlay === TopologyOverlay.PUBLIC_ADDRESS)
      .map((c) => ({
        type: 'cluster' as const,
        id: c.id,
        label: c.name,
        detail: 'Reached on its public address',
        severity: 'warning' as const,
      })),
  ];
}

/** Apps whose replicas run on more than one cluster, with the clusters they run on. Platform apps run on every cluster by design, so they are not listed. */
export function spreadOf(
  t: Snapshot,
): Array<{ appId: string; label: string; clusters: string[] }> {
  const byGroup = new Map<string, TopologyAppDto[]>();
  for (const a of t.apps) {
    if (a.kind === 'system') continue;
    byGroup.set(a.groupKey, [...(byGroup.get(a.groupKey) ?? []), a]);
  }
  return [...byGroup.values()]
    .filter((apps) => new Set(apps.map((a) => a.clusterId)).size > 1)
    .map((apps) => ({
      appId: apps[0].id,
      label: apps[0].displayName,
      clusters: [...new Set(apps.map((a) => clusterNameOf(t, a.clusterId)))],
    }));
}
