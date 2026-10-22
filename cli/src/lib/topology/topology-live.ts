import type {
  TopologyAppDto,
  TopologyResponseDto,
  TopologyStackDto,
  TopologyStreamPayloadDto,
} from '../../../../src/modules/topology/dto/topology.dto';
import { ApiClient } from '../api-client';
import { plural } from './topology-format';

type Snapshot = TopologyResponseDto;

export interface TopologyEvent {
  event: string;
  data: TopologyStreamPayloadDto;
}

const SEVERITY = ['error', 'warning', 'stopped', 'running'] as const;

function stacksWith(
  stacks: TopologyStackDto[],
  apps: TopologyAppDto[],
): TopologyStackDto[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  return stacks.flatMap((stack) => {
    const members = stack.appIds
      .map((id) => byId.get(id))
      .filter((a): a is TopologyAppDto => !!a);
    if (!members.length) return [];
    const status =
      SEVERITY.find((s) => members.some((a) => a.status === s)) ?? 'running';
    return [
      {
        ...stack,
        appIds: members.map((a) => a.id),
        status: status as TopologyStackDto['status'],
      },
    ];
  });
}

const withApps = (t: Snapshot, apps: TopologyAppDto[]): Snapshot => ({
  ...t,
  apps,
  stacks: stacksWith(t.stacks, apps),
});

function patchApp(
  t: Snapshot,
  appId: string | undefined,
  patch: Partial<TopologyAppDto>,
): Snapshot {
  if (!appId || !t.apps.some((a) => a.id === appId)) return t;
  return withApps(
    t,
    t.apps.map((a) => (a.id === appId ? { ...a, ...patch } : a)),
  );
}

function withDeployed(t: Snapshot, app: TopologyAppDto): Snapshot {
  const others = t.apps.filter((a) => a.id !== app.id);
  const known = t.stacks.some((s) => s.id === app.stackId);
  const stacks = known
    ? t.stacks.map((s) =>
        s.id === app.stackId && !s.appIds.includes(app.id)
          ? { ...s, appIds: [...s.appIds, app.id] }
          : s,
      )
    : [
        ...t.stacks,
        {
          id: app.stackId,
          clusterId: app.clusterId,
          name: app.displayName,
          type: 'standalone',
          primaryAppId: app.id,
          appIds: [app.id],
          status: app.status,
        } as unknown as TopologyStackDto,
      ];
  return withApps({ ...t, stacks }, [...others, app]);
}

function withScaled(t: Snapshot, data: TopologyStreamPayloadDto): Snapshot {
  return patchApp(t, data.appId, {
    ...(data.replicas ? { replicas: data.replicas } : {}),
    ...(data.replicaCount !== undefined
      ? { replicaCount: data.replicaCount }
      : {}),
    scalingNote: data.scalingNote ?? null,
  });
}

function withServerAdded(
  t: Snapshot,
  server: TopologyStreamPayloadDto['server'],
): Snapshot {
  return {
    ...t,
    servers: [...t.servers.filter((s) => s.id !== server.id), server],
  };
}

function withCapacities(
  t: Snapshot,
  capacities: TopologyStreamPayloadDto['capacities'],
): Snapshot {
  const changes = new Map((capacities ?? []).map((c) => [c.serverId, c]));
  if (!changes.size) return t;
  return {
    ...t,
    servers: t.servers.map((s) => {
      const change = changes.get(s.id);
      return change
        ? { ...s, capacity: change.capacity, podCount: change.podCount }
        : s;
    }),
  };
}

/** The snapshot after one change from the stream, as the dashboard patches it; the same object when nothing applies. */
export function applyTopologyEvent(
  t: Snapshot,
  { event, data }: TopologyEvent,
): Snapshot {
  switch (event) {
    case 'app.status_changed':
      return patchApp(t, data.appId, {
        ...(data.status ? { status: data.status } : {}),
        statusReason: data.statusReason ?? null,
      });
    case 'app.scaled':
      return withScaled(t, data);
    case 'app.deployed':
      return data.app ? withDeployed(t, data.app) : t;
    case 'app.removed':
      return data.appId
        ? withApps(
            t,
            t.apps.filter((a) => a.id !== data.appId),
          )
        : t;
    case 'server.added':
      return data.server ? withServerAdded(t, data.server) : t;
    case 'server.removed':
      return data.serverId
        ? { ...t, servers: t.servers.filter((s) => s.id !== data.serverId) }
        : t;
    case 'server.capacity':
      return withCapacities(t, data.capacities);
    case 'links.changed':
      return {
        ...t,
        links: data.links ?? t.links,
        clusterLinks: data.clusterLinks ?? t.clusterLinks,
      };
    default:
      return t;
  }
}

/** One line for a change a person would notice; null for the ones that only move numbers. */
export function describeEvent(
  before: Snapshot,
  { event, data }: TopologyEvent,
): string | null {
  const app = before.apps.find((a) => a.id === data.appId);
  const name = app?.displayName ?? data.app?.displayName ?? data.appId;
  switch (event) {
    case 'app.scaled': {
      if (data.replicaCount === undefined || !app) return null;
      const verb =
        data.replicaCount > app.replicaCount ? 'scaled up' : 'scaled down';
      return `${name} ${verb}: ${app.replicaCount} → ${plural(data.replicaCount, 'replica')}`;
    }
    case 'app.status_changed': {
      const reason = data.statusReason ? `: ${data.statusReason}` : '';
      return `${name} is ${data.status ?? 'changed'}${reason}`;
    }
    case 'app.deployed':
      return `${name} deployed`;
    case 'app.removed':
      return `${name} removed`;
    case 'server.added':
      return `Server ${data.server?.nodeName ?? ''} added`.trim();
    case 'server.removed':
      return `Server ${before.servers.find((s) => s.id === data.serverId)?.nodeName ?? data.serverId} removed`;
    default:
      return null;
  }
}

/** Splits a Server-Sent Events body into messages; a frame without an `event:` line may carry `{type, data}` itself. */
export function parseFrame(frame: string): TopologyEvent | null {
  let name: string | null = null;
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  let body: unknown;
  try {
    body = JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
  if (name) return { event: name, data: body as TopologyStreamPayloadDto };
  const wrapped = body as { type?: string; data?: TopologyStreamPayloadDto };
  return wrapped?.type
    ? { event: wrapped.type, data: wrapped.data ?? {} }
    : null;
}

export interface LiveTopology {
  stop(): void;
}

export interface LiveHandlers {
  onSnapshot(snapshot: Snapshot, change: string | null): void;
  onConnection?(live: boolean): void;
}

const HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * The snapshot kept current from the stream the dashboard listens to. A lost
 * stream reloads the whole snapshot before reconnecting, so nothing missed
 * while away stays missing.
 */
export function liveTopology(
  api: ApiClient,
  system: boolean,
  initial: Snapshot,
  handlers: LiveHandlers,
): LiveTopology {
  const query = system ? '?system=1' : '';
  let snapshot = initial;
  let stopped = false;
  let attempts = 0;
  let current: (NodeJS.ReadableStream & { destroy?: () => void }) | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let retry: NodeJS.Timeout | null = null;

  const drop = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    current?.destroy?.();
    current = null;
  };

  const arm = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => reconnect(), HEARTBEAT_TIMEOUT_MS);
  };

  const reconnect = () => {
    drop();
    if (stopped || retry) return;
    handlers.onConnection?.(false);
    attempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5));
    retry = setTimeout(async () => {
      retry = null;
      if (stopped) return;
      try {
        snapshot = await api.get<Snapshot>(`/topology${query}`);
        handlers.onSnapshot(snapshot, null);
      } catch {
        // The reconnect below reports the failure by staying offline.
      }
      void connect();
    }, delay);
  };

  const connect = async () => {
    try {
      const stream = (await api.getStream(
        `/topology/stream${query}`,
      )) as NodeJS.ReadableStream & {
        destroy?: () => void;
      };
      if (stopped) {
        stream.destroy?.();
        return;
      }
      current = stream;
      handlers.onConnection?.(true);
      arm();
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8').replaceAll('\r\n', '\n');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const message = parseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (!message) continue;
          attempts = 0;
          arm();
          if (message.event === 'heartbeat') continue;
          const next = applyTopologyEvent(snapshot, message);
          if (next === snapshot) continue;
          const change = describeEvent(snapshot, message);
          snapshot = next;
          handlers.onSnapshot(snapshot, change);
        }
      });
      stream.on('end', () => current === stream && reconnect());
      stream.on('error', () => current === stream && reconnect());
    } catch {
      reconnect();
    }
  };

  void connect();
  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      drop();
    },
  };
}
