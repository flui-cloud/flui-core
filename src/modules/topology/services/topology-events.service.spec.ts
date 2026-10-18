// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; the topology service is stubbed here and never reaches it.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { Subject } from 'rxjs';
import {
  TopologyChange,
  TopologyEventsService,
} from './topology-events.service';
import { TopologyEventType } from '../enums/topology.enums';

/**
 * The first snapshot must never gate the port: it calls every cluster's API,
 * and a powered-off host swallows the packets for ~133s against a probe that
 * kills at 90.
 *
 * The same mistake was fixed in the volume-pause sweeper an hour earlier and
 * survived here because that search looked for `onApplicationBootstrap` — this
 * hook is `onModuleInit`. Hence a test in each place rather than a memory.
 */
describe('TopologyEventsService boot', () => {
  function make(buildTopology: jest.Mock) {
    const service = Object.create(
      TopologyEventsService.prototype,
    ) as TopologyEventsService;
    const r = service as unknown as Record<string, unknown>;
    r.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    r.topologyService = { isMockMode: () => false, buildTopology };
    r.apps = new Map();
    r.servers = new Map();
    r.sentCapacity = new Map();
    r.capacitySentAt = 0;
    r.debouncedStatus = new Map();
    r.subject = new Subject();
    r.latestAt = 0;
    r.watchers = 0;
    r.askedAt = 0;
    r.stopped = false;
    return service;
  }

  afterEach(() => jest.clearAllTimers());

  it('returns before the first snapshot has been built', () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const buildTopology = jest.fn(() => pending);
    const service = make(buildTopology);

    // No promise for Nest to await.
    const returned: void = service.onModuleInit();
    expect(returned).toBeUndefined();

    release({ clusters: [] });
    clearInterval(
      (service as unknown as { pollTimer: NodeJS.Timeout }).pollTimer,
    );
  });

  it('does not crash the process when the first snapshot fails', async () => {
    const buildTopology = jest.fn(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    const service = make(buildTopology);

    service.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      (service as unknown as { logger: { error: jest.Mock } }).logger.error,
    ).toHaveBeenCalled();
    service.onModuleDestroy();
  });
});

describe('TopologyEventsService load', () => {
  const snapshot = { clusters: [], servers: [], apps: [], links: [] };

  function make() {
    const buildTopology = jest.fn(async () => snapshot);
    const service = new TopologyEventsService({
      isMockMode: () => false,
      buildTopology,
    } as never);
    (service as unknown as { logger: unknown }).logger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };
    return { service, buildTopology };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('builds once for any number of callers arriving together', async () => {
    const { service, buildTopology } = make();
    const answers = await Promise.all(
      Array.from({ length: 50 }, () => service.snapshot()),
    );
    expect(buildTopology).toHaveBeenCalledTimes(1);
    expect(new Set(answers).size).toBe(1);
    service.onModuleDestroy();
  });

  it('serves the shared snapshot without reading the clusters again while it is fresh', async () => {
    const { service, buildTopology } = make();
    await service.snapshot();
    await service.snapshot();
    expect(buildTopology).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('stops reading the clusters when nobody looks, and rebuilds a stale snapshot once on the next look', async () => {
    const { service, buildTopology } = make();
    service.onModuleInit();
    await flush();
    expect(buildTopology).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 30; i++) {
      await jest.advanceTimersByTimeAsync(10_000);
      await flush();
    }
    const whileIdle = buildTopology.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(buildTopology).toHaveBeenCalledTimes(whileIdle);

    await Promise.all([service.snapshot(), service.snapshot()]);
    expect(buildTopology).toHaveBeenCalledTimes(whileIdle + 1);
    service.onModuleDestroy();
  });

  it('keeps the map fresh while a stream is open, and never starts a build before the last one ends', async () => {
    const { service, buildTopology } = make();
    let release: () => void = () => {};
    buildTopology.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(snapshot);
        }) as never,
    );
    service.onModuleInit();
    const sub = service.changes$.subscribe();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(buildTopology).toHaveBeenCalledTimes(1);

    release();
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(buildTopology).toHaveBeenCalledTimes(2);

    sub.unsubscribe();
    release();
    service.onModuleDestroy();
  });
});

describe('TopologyEventsService changes', () => {
  const server = (id: string, usedMemPct: number) => ({
    id,
    clusterId: 'c1',
    capacity: { usedMemPct },
    podCount: 1,
  });
  const app = (id: string, replicaCount = 1) => ({
    id,
    clusterId: 'c1',
    status: 'running',
    statusReason: null,
    replicaCount,
    replicas: [{ serverId: 's1', count: replicaCount }],
  });

  function make(snapshots: unknown[]) {
    const service = Object.create(
      TopologyEventsService.prototype,
    ) as TopologyEventsService;
    const r = service as unknown as Record<string, unknown>;
    const queue = [...snapshots];
    r.logger = { error: jest.fn() };
    r.topologyService = { buildTopology: jest.fn(async () => queue.shift()) };
    r.apps = new Map();
    r.servers = new Map();
    r.sentCapacity = new Map();
    r.sentLinks = '';
    r.capacitySentAt = 0;
    r.debouncedStatus = new Map();
    const subject = new Subject<TopologyChange>();
    r.subject = subject;
    const seen: TopologyChange[] = [];
    subject.subscribe((c) => seen.push(c));
    const refresh = () =>
      (r.refreshSnapshot as () => Promise<void>).call(service);
    return { r, seen, refresh };
  }

  it('takes the first snapshot as the baseline and announces nothing', async () => {
    const { seen, refresh } = make([
      { apps: [app('a1'), app('a2')], servers: [server('s1', 40)] },
    ]);
    await refresh();
    expect(seen).toEqual([]);
  });

  it('announces a new app with the app nested, and a removal with its cluster', async () => {
    const { seen, refresh } = make([
      { apps: [app('a1')], servers: [] },
      { apps: [app('a2')], servers: [] },
    ]);
    await refresh();
    await refresh();
    expect(seen.map((c) => c.event)).toEqual([
      TopologyEventType.APP_DEPLOYED,
      TopologyEventType.APP_REMOVED,
    ]);
    expect(seen[0].data.app?.id).toBe('a2');
    expect(seen[1].data).toEqual({ appId: 'a1', clusterId: 'c1' });
  });

  it('announces a scale with the cluster it happened on', async () => {
    const { seen, refresh } = make([
      { apps: [app('a1', 1)], servers: [] },
      { apps: [app('a1', 3)], servers: [] },
    ]);
    await refresh();
    await refresh();
    expect(seen[0]).toMatchObject({
      event: TopologyEventType.APP_SCALED,
      data: { appId: 'a1', clusterId: 'c1', replicaCount: 3 },
    });
  });

  it('sends capacity at most every 30 s, and only for the servers that changed', async () => {
    const { r, seen, refresh } = make([
      { apps: [], servers: [server('s1', 40), server('s2', 50)] },
      { apps: [], servers: [server('s1', 41), server('s2', 50)] },
      { apps: [], servers: [server('s1', 42), server('s2', 50)] },
    ]);
    await refresh();
    await refresh();
    expect(seen).toEqual([]);
    r.capacitySentAt = Date.now() - 31_000;
    await refresh();
    expect(seen).toEqual([
      {
        event: TopologyEventType.SERVER_CAPACITY,
        data: {
          capacities: [
            {
              serverId: 's1',
              clusterId: 'c1',
              capacity: { usedMemPct: 42 },
              podCount: 1,
            },
          ],
        },
      },
    ]);
  });

  it('sends the links again when they or their traffic change, on the 30 s rhythm', async () => {
    const link = (rps: number) => ({
      id: 'internet>a1',
      traffic: { measured: true, rps },
    });
    const { r, seen, refresh } = make([
      { apps: [], servers: [], links: [link(10)], clusterLinks: [] },
      { apps: [], servers: [], links: [link(10)], clusterLinks: [] },
      { apps: [], servers: [], links: [link(12)], clusterLinks: [] },
    ]);
    await refresh();
    r.capacitySentAt = Date.now() - 31_000;
    await refresh();
    expect(seen).toEqual([]);
    r.capacitySentAt = Date.now() - 31_000;
    await refresh();
    expect(seen).toEqual([
      {
        event: TopologyEventType.LINKS_CHANGED,
        data: { links: [link(12)], clusterLinks: [] },
      },
    ]);
  });
});
