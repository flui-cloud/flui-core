import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { ToolDef, coerceBoolean, defineTool } from './mcp-tool.util';
import type {
  TopologyAppDto,
  TopologyResponseDto,
  TopologyServerDto,
} from '../../topology/dto/topology.dto';
import {
  appSlice,
  attentionOf,
  clusterNameOf,
  clusterSlice,
  findApp,
  findCluster,
  findServer,
  isSystem,
  isTroubled,
  missMessage,
  serverSlice,
  spreadOf,
  trafficIn,
  worstAppStatus,
} from '../../topology/utils/topology-slice.util';

type Snapshot = TopologyResponseDto;

type Focus =
  | { type: 'fleet' }
  | { type: 'cluster' | 'app' | 'server'; id: string };

interface TopologyRead {
  focus: Focus;
  topology: Snapshot;
}

function focusOf(
  t: Snapshot,
  args: { cluster?: string; app?: string; server?: string },
): Focus {
  if (args.app) {
    const found = findApp(t, args.app, args.cluster);
    if ('found' in found) return { type: 'app', id: found.found.id };
    throw new Error(
      missMessage(t, 'app', args.app, found.candidates, args.cluster),
    );
  }
  if (args.server) {
    const found = findServer(t, args.server, args.cluster);
    if ('found' in found) return { type: 'server', id: found.found.id };
    throw new Error(
      missMessage(t, 'server', args.server, found.candidates, args.cluster),
    );
  }
  if (args.cluster) {
    const found = findCluster(t, args.cluster);
    if ('found' in found) return { type: 'cluster', id: found.found.id };
    throw new Error(missMessage(t, 'cluster', args.cluster, found.candidates));
  }
  return { type: 'fleet' };
}

const appRow = (t: Snapshot, a: TopologyAppDto) => ({
  id: a.id,
  name: a.displayName,
  cluster: clusterNameOf(t, a.clusterId),
  status: a.status,
  ...(a.statusReason ? { reason: a.statusReason } : {}),
  replicas: a.replicaCount,
  exposure: a.exposure,
  requestsPerSecondIn: trafficIn(t, a.id),
});

const serverRow = (s: TopologyServerDto) => ({
  id: s.id,
  name: s.nodeName,
  role: s.role,
  type: s.serverType,
  architecture: s.architecture,
  status: s.status,
  memoryUsedPct: s.capacity?.usedMemPct ?? null,
  cpuUsedPct: s.capacity?.usedCpuPct ?? null,
  replicas: s.podCount,
});

function platformOf(t: Snapshot, apps: TopologyAppDto[]) {
  const own = apps.filter(isSystem);
  if (!own.length) return null;
  return {
    apps: own.length,
    status: worstAppStatus(own),
    troubled: own.filter(isTroubled).map((a) => appRow(t, a)),
  };
}

function fleetView(t: Snapshot) {
  return {
    clusters: t.clusters.map((c) => {
      const own = t.apps.filter((a) => a.clusterId === c.id);
      return {
        id: c.id,
        name: c.name,
        provider: c.provider,
        region: c.region,
        type: c.type,
        status: c.status,
        reachedOver: c.overlay,
        servers: t.servers.filter((s) => s.clusterId === c.id).length,
        apps: own.filter((a) => !isSystem(a)).length,
        problems: own.filter(isTroubled).length,
        platform: platformOf(t, own),
      };
    }),
    needsAttention: attentionOf(t),
    spreadAcrossClusters: spreadOf(t),
    apps: t.apps.filter((a) => !isSystem(a)).map((a) => appRow(t, a)),
  };
}

function clusterView(t: Snapshot, id: string) {
  const slice = clusterSlice(t, id);
  const stackOf = (a: TopologyAppDto) =>
    slice.stacks.find((s) => s.id === a.stackId && s.appIds.length > 1)?.name ??
    null;
  const projectOf = (a: TopologyAppDto) =>
    slice.projects.find((p) => p.id === a.projectId)?.name ?? null;
  return {
    cluster: slice.cluster,
    apps: slice.apps
      .filter((a) => !isSystem(a))
      .map((a) => ({
        ...appRow(t, a),
        stack: stackOf(a),
        project: projectOf(a),
      })),
    platform: platformOf(t, slice.apps),
    servers: slice.servers.map(serverRow),
  };
}

function appView(t: Snapshot, id: string) {
  const slice = appSlice(t, id);
  const a = slice.app!;
  const peer = (appId: string | undefined) => {
    const p = slice.peers.find((x) => x.id === appId);
    return p
      ? {
          id: p.id,
          name: p.displayName,
          cluster: clusterNameOf(t, p.clusterId),
          status: p.status,
        }
      : null;
  };
  const internal = slice.links.filter((l) => l.from.appId);
  return {
    ...appRow(t, a),
    kind: a.kind,
    category: a.category,
    stack:
      slice.stack && slice.stack.appIds.length > 1 ? slice.stack.name : null,
    project: slice.project?.name ?? null,
    memoryRequestMB: a.ramRequestMB,
    memoryLimitMB: a.ramLimitMB,
    cpuRequestM: a.cpuRequestM,
    cpuLimitM: a.cpuLimitM,
    scaling: a.scalingNote ?? a.scalingMode,
    routes: slice.links
      .filter((l) => !l.from.appId)
      .map((l) => ({
        host: l.routeHost,
        path: l.routePath,
        targetPort: l.targetPort,
        requestsPerSecond: l.traffic.measured ? l.traffic.rps : null,
        errorPct: l.traffic.measured ? l.traffic.errorPct : null,
      })),
    calledBy: internal
      .filter((l) => l.to.appId === id)
      .map((l) => ({
        ...peer(l.from.appId),
        port: l.label,
        crossCluster: l.crossCluster,
      })),
    talksTo: internal
      .filter((l) => l.from.appId === id)
      .map((l) => ({
        ...peer(l.to.appId),
        port: l.label,
        crossCluster: l.crossCluster,
      })),
    runsOn: a.replicas.map((r) => ({
      server:
        slice.servers.find((s) => s.id === r.serverId)?.nodeName ?? r.serverId,
      serverId: r.serverId,
      replicas: r.count,
    })),
  };
}

function serverView(t: Snapshot, id: string) {
  const slice = serverSlice(t, id);
  const s = slice.server!;
  return {
    ...serverRow(s),
    cluster: slice.cluster?.name ?? null,
    provider: s.provider,
    takesWork: s.takesWork,
    fluiNetwork: s.fluiNetwork,
    memoryReservedMi: s.capacity?.requestedMemMi ?? null,
    memoryAllocatableMi: s.capacity?.allocatableMemMi ?? null,
    apps: slice.apps.map((a) => ({
      ...appRow(t, a),
      here: a.replicas.find((r) => r.serverId === id)?.count ?? 0,
      platform: isSystem(a),
    })),
  };
}

function viewOf(t: Snapshot, focus: Focus) {
  switch (focus.type) {
    case 'cluster':
      return clusterView(t, focus.id);
    case 'app':
      return appView(t, focus.id);
    case 'server':
      return serverView(t, focus.id);
    default:
      return fleetView(t);
  }
}

const TOPOLOGY_NOTE =
  '`requestsPerSecondIn` is traffic arriving from the Internet; null means it is not measured, never zero. Platform apps are the ones Flui runs for itself, counted apart from the user’s apps.';

export const TOPOLOGY_TOOLS: ToolDef[] = [
  defineTool({
    name: 'topology_get',
    summary:
      'The fleet as the dashboard Topology shows it: clusters, apps, servers and what needs attention; or one cluster, app or server.',
    routes: ['GET /topology'],
    description:
      'Read the fleet the way the dashboard Topology draws it, narrowed to what the caller may read. With no argument: every cluster (provider, region, servers, apps, problems), `needsAttention` (apps in error or warning with the reason, servers past 90% memory, clusters down or reached on a public address — the same list the dashboard shows, in its order), the apps whose replicas run on several clusters, and every app with status, replicas and requests per second from the Internet. Pass `cluster` (name or id) for one cluster with its apps, its servers and the Flui platform summary; `app` (name or id, plus `cluster` when the name is on several clusters) for one app with its routes, who calls it, what it talks to and the servers its replicas run on; or `server` for one server with what runs on it. Names match case-insensitively; an ambiguous name is refused with the candidates. `system: true` also returns the apps Flui runs for itself, only to a caller who sees every cluster. Read-only: to change anything use the app and cluster tools.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      cluster: z
        .string()
        .optional()
        .describe(
          'Cluster name or id; alone it focuses that cluster, with `app` or `server` it narrows the search.',
        ),
      app: z.string().optional().describe('App name or id to focus.'),
      server: z.string().optional().describe('Server name or id to focus.'),
      system: coerceBoolean()
        .optional()
        .describe('Include the apps Flui runs for itself.'),
    },
    run: async (args, ctx): Promise<TopologyRead> => {
      const topology = await ctx.api.get<Snapshot>(
        `/topology${args.system ? '?system=1' : ''}`,
      );
      return { focus: focusOf(topology, args), topology };
    },
    forModel: (data) => {
      const { focus, topology: t } = data as TopologyRead;
      return {
        focus: focus.type,
        generatedAt: t.generatedAt,
        ...viewOf(t, focus),
        note: TOPOLOGY_NOTE,
      };
    },
  }),
];
