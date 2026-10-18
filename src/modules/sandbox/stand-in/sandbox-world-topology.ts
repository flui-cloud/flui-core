/**
 * Topology of the example organisation, for guests and for local mock mode.
 *
 * Everything moving here is a function of the clock, never of a random draw:
 * two guests looking at the same second see the same picture, a screenshot can
 * be taken again, and the world can never drift into an ugly state. The
 * snapshot and the stream are computed by the same function, so a page that
 * patches the snapshot with the stream lands where a fresh snapshot would.
 */
import {
  Observable,
  from,
  interval,
  map,
  mergeMap,
  pairwise,
  startWith,
} from 'rxjs';
import {
  TopologyAppDto,
  TopologyClusterDto,
  TopologyClusterLinkDto,
  TopologyLinkDto,
  TopologyResponseDto,
  TopologyServerDto,
  TopologyStackDto,
} from '../../topology/dto/topology.dto';
import {
  TopologyAppCategory,
  TopologyAppKind,
  TopologyAppStatus,
  TopologyArchitecture,
  TopologyClusterType,
  TopologyEndpointKind,
  TopologyEventType,
  TopologyExposure,
  TopologyFluiNetwork,
  TopologyHealthStatus,
  TopologyLinkSource,
  TopologyOverlay,
  TopologyScalingMode,
  TopologyServerRole,
  TopologyStackType,
  TopologyWorkloadKind,
} from '../../topology/enums/topology.enums';
import type { TopologyChange } from '../../topology/services/topology-events.service';
import { CPU_MILLICORES, MEMORY_MI } from './sandbox-world-scaling-fleet';
import { FIREWALL_RULES } from './sandbox-world';
import { inboundOf } from '../../topology/utils/topology-inbound.util';

/** Providers whose firewall Flui applies; the others are listed without one, as on a real fleet. */
const MANAGED_FIREWALL = new Set(['hetzner', 'scaleway', 'ovh']);
import { ExampleShape } from './sandbox-world-fleet';
import {
  WORLD_APPS,
  WORLD_CLUSTERS,
  WORLD_LINKS,
  WORLD_SERVERS,
  WORLD_STACKS,
  FLUI_NETWORK_EXCEPTIONS,
  WorldApp,
  exampleProviderId,
  WorldServer,
  worldRequested,
  exampleProjectOf,
  WORLD_PROJECTS,
} from './sandbox-world-topology-data';

const K3S_VERSION = 'v1.31.4+k3s1';
const HEARTBEAT_MS = 15_000;
const CAPACITY_EVERY_MS = 30_000;
const LINKS_EVERY_MS = 10_000;
const TICK_MS = 5_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const wave = (now: number, periodMs: number, phase: number) =>
  Math.sin((2 * Math.PI * now) / periodMs + phase);

const BILLING = 'example-app-1-billing-api';
const EDGE_API = 'example-app-3-edge-api';
const STOREFRONT = 'example-app-1';

/** The billing API runs out of memory, restarts, runs out again. */
function billingFailing(now: number): boolean {
  return Math.floor(now / 20_000) % 2 === 0;
}

/** The storefront gets one more replica for a minute and a half, every three. */
function storefrontBusy(now: number): boolean {
  return Math.floor(now / 90_000) % 2 === 1;
}

function placement(app: WorldApp, now: number): Record<string, number> {
  if (app.id !== STOREFRONT || !storefrontBusy(now)) return app.on;
  return { ...app.on, 'flui-arm-2': (app.on['flui-arm-2'] ?? 0) + 1 };
}

function statusOf(app: WorldApp, now: number) {
  if (app.id === BILLING) {
    return billingFailing(now)
      ? {
          status: TopologyAppStatus.ERROR,
          statusReason: 'CrashLoopBackOff · OOMKilled',
        }
      : { status: TopologyAppStatus.WARNING, statusReason: 'Restarting' };
  }
  if (app.id === EDGE_API) {
    return {
      status: TopologyAppStatus.WARNING,
      statusReason: 'Restarted 7 times in the last hour',
    };
  }
  return { status: TopologyAppStatus.RUNNING, statusReason: null };
}

function allocatable(server: WorldServer) {
  const shape = server.serverType.toUpperCase() as ExampleShape;
  return {
    cpu: CPU_MILLICORES[shape] ?? server.cpuCores * 1000 - 200,
    mem: MEMORY_MI[shape] ?? Math.round(server.ramMb * 0.95),
  };
}

function serverDto(
  server: WorldServer,
  index: number,
  now: number,
  pods: Map<string, number>,
): TopologyServerDto {
  const cluster = WORLD_CLUSTERS.find((c) => c.id === server.clusterId)!;
  const room = allocatable(server);
  return {
    id: server.id,
    clusterId: server.clusterId,
    nodeName: server.name,
    provider: cluster.provider,
    providerResourceId: exampleProviderId(server.id),
    serverType: server.serverType,
    architecture:
      server.architecture === 'arm'
        ? TopologyArchitecture.ARM
        : TopologyArchitecture.X86,
    role:
      server.role === 'master'
        ? TopologyServerRole.CONTROL_PLANE
        : TopologyServerRole.WORKER,
    takesWork: server.role === 'worker' || cluster.id === 'example-cluster-5',
    status: TopologyHealthStatus.HEALTHY,
    capacity: {
      allocatableCpuM: room.cpu,
      allocatableMemMi: room.mem,
      requestedCpuM: worldRequested(server).cpuM,
      requestedMemMi: worldRequested(server).memMi,
      usedCpuPct: round1(server.used.cpu * 100 + 4 * wave(now, 240_000, index)),
      usedMemPct: round1(
        Math.min(96, server.used.mem * 100 + 1.5 * wave(now, 300_000, index)),
      ),
    },
    podCount: pods.get(server.id) ?? 0,
    privateNetwork: cluster.privateNetwork,
    fluiNetwork: (FLUI_NETWORK_EXCEPTIONS[server.name] ??
      'active') as TopologyFluiNetwork,
  };
}

function stackIdOf(app: WorldApp): string {
  return app.stack ? `example-stack-${app.stack}` : `app:${app.id}`;
}

const SERVER_ID = new Map(
  WORLD_SERVERS.map((s) => [`${s.clusterId}/${s.name}`, s.id]),
);

const SCALING_OF: Partial<Record<string, TopologyScalingMode>> = {
  statefulset: TopologyScalingMode.STATEFULSET,
  daemonset: TopologyScalingMode.DAEMONSET,
};

function scalingNoteOf(
  mode: TopologyScalingMode,
  replicas: number,
): string | null {
  if (mode === TopologyScalingMode.STATEFULSET)
    return `StatefulSet · ${replicas} replicas`;
  if (mode === TopologyScalingMode.DAEMONSET) return 'DaemonSet · 1 per node';
  return null;
}

function appDto(app: WorldApp, now: number): TopologyAppDto {
  const on = placement(app, now);
  const replicas = Object.entries(on).map(([name, count]) => ({
    serverId: SERVER_ID.get(`${app.clusterId}/${name}`)!,
    count,
  }));
  const replicaCount = replicas.reduce((s, r) => s + r.count, 0);
  const scalingMode = SCALING_OF[app.workload] ?? TopologyScalingMode.MANUAL;
  return {
    id: app.id,
    clusterId: app.clusterId,
    stackId: stackIdOf(app),
    groupKey: app.group ? `group:${app.group}` : `app:${app.id}`,
    projectId: exampleProjectOf(app),
    name: app.slug,
    slug: app.slug.slice(0, 14),
    displayName: app.name,
    category: app.category as TopologyAppCategory,
    kind: app.system ? TopologyAppKind.SYSTEM : TopologyAppKind.USER,
    workloadKind: app.workload as TopologyWorkloadKind,
    exposure: app.exposure as TopologyExposure,
    namespace: app.system
      ? 'flui-system'
      : `northwind-${app.stack ?? app.slug}`,
    ...statusOf(app, now),
    ramRequestMB: app.ramMb,
    ramLimitMB: app.ramMb * 2,
    cpuRequestM: app.cpuM,
    cpuLimitM: app.cpuM * 2,
    primaryServerId: replicas[0].serverId,
    replicas,
    replicaCount,
    scalingMode,
    scalingNote: scalingNoteOf(scalingMode, replicaCount),
  };
}

const SEVERITY = [
  TopologyAppStatus.ERROR,
  TopologyAppStatus.WARNING,
  TopologyAppStatus.STOPPED,
  TopologyAppStatus.RUNNING,
];
const worst = (statuses: TopologyAppStatus[]) =>
  SEVERITY.find((s) => statuses.includes(s)) ?? TopologyAppStatus.RUNNING;

function stacksOf(apps: TopologyAppDto[]): TopologyStackDto[] {
  const composed = WORLD_STACKS.map((stack) => {
    const members = WORLD_APPS.filter((a) => a.stack === stack.key);
    const dtos = apps.filter((a) => members.some((m) => m.id === a.id));
    const primary = members.find((m) => m.slug === stack.primary)!;
    return {
      id: `example-stack-${stack.key}`,
      clusterId: members[0].clusterId,
      name: stack.name,
      type: TopologyStackType.COMPOSED,
      primaryAppId: primary.id,
      appIds: dtos.map((a) => a.id),
      status: worst(dtos.map((a) => a.status)),
    };
  });
  const standalone = apps
    .filter((a) => a.stackId.startsWith('app:'))
    .map((a) => ({
      id: a.stackId,
      clusterId: a.clusterId,
      name: a.displayName,
      type: TopologyStackType.STANDALONE,
      primaryAppId: a.id,
      appIds: [a.id],
      status: a.status,
    }));
  return [...composed, ...standalone];
}

function linksOf(now: number, apps: TopologyAppDto[]): TopologyLinkDto[] {
  const clusterOf = new Map(apps.map((a) => [a.id, a.clusterId]));
  const tunnel = new Set<string>(
    WORLD_CLUSTERS.filter((c) => c.overlay === 'tunnel').map((c) => c.id),
  );
  return WORLD_LINKS.map((link, index) => {
    const target = WORLD_APPS.find((a) => a.id === link.to)!;
    const fromCluster = link.from ? clusterOf.get(link.from) : undefined;
    const crossCluster = !!fromCluster && fromCluster !== target.clusterId;
    const failing =
      link.to === BILLING && billingFailing(now) ? 64 : link.errorPct;
    return {
      id: `example-link-${index + 1}`,
      from: link.from
        ? { kind: TopologyEndpointKind.APP, appId: link.from }
        : { kind: TopologyEndpointKind.INTERNET },
      to: { kind: TopologyEndpointKind.APP, appId: link.to },
      source: link.source as TopologyLinkSource,
      label: link.from ? `:${target.port ?? 8080}` : 'HTTPS',
      crossCluster,
      viaTunnel:
        crossCluster &&
        tunnel.has(fromCluster!) &&
        tunnel.has(target.clusterId),
      routeHost: link.host ?? null,
      routePath: link.from ? null : (link.path ?? '/'),
      targetPort: link.from ? null : (target.port ?? 8080),
      traffic:
        link.rps === undefined
          ? { measured: false, rps: null, errorPct: null }
          : {
              measured: true,
              rps: round1(
                link.rps * (1 + 0.18 * wave(now, 120_000, index * 0.7)),
              ),
              errorPct: round1(failing ?? 0),
            },
    };
  });
}

function clusterLinksOf(
  links: TopologyLinkDto[],
  apps: TopologyAppDto[],
): TopologyClusterLinkDto[] {
  const clusterOf = new Map(apps.map((a) => [a.id, a.clusterId]));
  const pairs = new Map<string, TopologyClusterLinkDto>();
  for (const link of links.filter((l) => l.crossCluster)) {
    const from = clusterOf.get(link.from.appId!)!;
    const to = clusterOf.get(link.to.appId!)!;
    const key = `${from}>${to}`;
    const pair = pairs.get(key) ?? {
      fromClusterId: from,
      toClusterId: to,
      linkCount: 0,
      rps: null,
      viaTunnel: link.viaTunnel,
    };
    pair.linkCount += 1;
    pairs.set(key, pair);
  }
  return [...pairs.values()];
}

function clusterDto(
  cluster: (typeof WORLD_CLUSTERS)[number],
  servers: TopologyServerDto[],
  stacks: TopologyStackDto[],
  apps: TopologyAppDto[],
): TopologyClusterDto {
  const own = apps.filter((a) => a.clusterId === cluster.id);
  const errors = own.filter((a) => a.status === TopologyAppStatus.ERROR).length;
  return {
    id: cluster.id,
    name: cluster.name,
    displayName: cluster.name,
    provider: cluster.provider,
    region: cluster.region,
    type:
      cluster.type === 'control'
        ? TopologyClusterType.CONTROL
        : TopologyClusterType.WORKLOAD,
    status: errors
      ? TopologyHealthStatus.DEGRADED
      : TopologyHealthStatus.HEALTHY,
    k3sVersion: K3S_VERSION,
    overlay:
      cluster.overlay === 'tunnel'
        ? TopologyOverlay.TUNNEL
        : TopologyOverlay.PUBLIC_ADDRESS,
    counts: {
      apps: own.length,
      stacks: stacks.filter((s) => s.clusterId === cluster.id).length,
      servers: servers.filter((s) => s.clusterId === cluster.id).length,
      errors,
      warnings: own.filter((a) => a.status === TopologyAppStatus.WARNING)
        .length,
    },
    inbound: MANAGED_FIREWALL.has(cluster.provider)
      ? inboundOf({ desiredRules: FIREWALL_RULES })
      : null,
  };
}

export function exampleTopology(now: number): TopologyResponseDto {
  const apps = WORLD_APPS.map((app) => appDto(app, now));
  const pods = new Map<string, number>();
  for (const app of apps) {
    for (const r of app.replicas) {
      pods.set(r.serverId, (pods.get(r.serverId) ?? 0) + r.count);
    }
  }
  const servers = WORLD_SERVERS.map((s, i) => serverDto(s, i, now, pods));
  const stacks = stacksOf(apps);
  const links = linksOf(now, apps);
  const clusters = WORLD_CLUSTERS.map((c) =>
    clusterDto(c, servers, stacks, apps),
  );
  return {
    version: '2',
    generatedAt: new Date(now).toISOString(),
    clusters,
    servers,
    stacks,
    apps,
    links,
    projects: WORLD_PROJECTS.map((p) => ({ id: p.id, name: p.name })),
    clusterLinks: clusterLinksOf(links, apps),
    stats: {
      totalClusters: clusters.length,
      totalServers: servers.length,
      totalStacks: stacks.length,
      totalApps: apps.length,
      totalReplicas: apps.reduce((s, a) => s + a.replicaCount, 0),
      totalRamMB: apps.reduce((s, a) => s + a.ramRequestMB * a.replicaCount, 0),
      errorCount: apps.filter((a) => a.status === TopologyAppStatus.ERROR)
        .length,
      warningCount: apps.filter((a) => a.status === TopologyAppStatus.WARNING)
        .length,
      droppedApps: 0,
    },
  };
}

/** What changed between two moments of the world, as the real stream says it. */
export function exampleTopologyChanges(
  before: number,
  after: number,
): TopologyChange[] {
  const prev = exampleTopology(before);
  const next = exampleTopology(after);
  const changes: TopologyChange[] = [];
  const crossed = (every: number) =>
    Math.floor(before / every) !== Math.floor(after / every);

  for (const app of next.apps) {
    const was = prev.apps.find((a) => a.id === app.id)!;
    if (was.status !== app.status || was.statusReason !== app.statusReason) {
      changes.push({
        event: TopologyEventType.APP_STATUS_CHANGED,
        data: {
          appId: app.id,
          clusterId: app.clusterId,
          status: app.status,
          statusReason: app.statusReason,
        },
      });
    }
    if (was.replicaCount !== app.replicaCount) {
      changes.push({
        event: TopologyEventType.APP_SCALED,
        data: {
          appId: app.id,
          clusterId: app.clusterId,
          replicas: app.replicas,
          replicaCount: app.replicaCount,
          scalingNote: app.scalingNote,
        },
      });
    }
  }
  if (crossed(CAPACITY_EVERY_MS)) {
    changes.push({
      event: TopologyEventType.SERVER_CAPACITY,
      data: {
        capacities: next.servers.map((s) => ({
          serverId: s.id,
          clusterId: s.clusterId,
          capacity: s.capacity,
          podCount: s.podCount,
        })),
      },
    });
  }
  if (crossed(LINKS_EVERY_MS)) {
    changes.push({
      event: TopologyEventType.LINKS_CHANGED,
      data: { links: next.links, clusterLinks: next.clusterLinks },
    });
  }
  if (crossed(HEARTBEAT_MS)) {
    changes.push({
      event: TopologyEventType.HEARTBEAT,
      data: { ts: new Date(after).toISOString() },
    });
  }
  return changes;
}

/** The world's own stream: a tick every five seconds, and only what changed. */
export function exampleTopologyStream(
  clock: () => number = Date.now,
  tickMs = TICK_MS,
): Observable<TopologyChange> {
  return interval(tickMs).pipe(
    map(() => clock()),
    startWith(clock()),
    pairwise(),
    mergeMap(([before, after]) => from(exampleTopologyChanges(before, after))),
  );
}
