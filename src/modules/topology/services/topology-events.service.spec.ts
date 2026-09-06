// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; the topology service is stubbed here and never reaches it.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { TopologyEventsService } from './topology-events.service';

/**
 * The first snapshot must never be a precondition for the API answering.
 *
 * `onModuleInit` runs before `app.listen()`, and building a topology calls the
 * Kubernetes API of every cluster. A powered-off host swallows the packets
 * instead of refusing them — about 133 seconds before the kernel gives up,
 * against a liveness probe that kills the pod at 90. One workload cluster that
 * was down stopped the control plane from starting at all, which is the exact
 * moment somebody needs it in order to rebuild that cluster.
 *
 * The same mistake had already been fixed in the volume-pause sweeper the hour
 * before. It was still here because the search that found the first one looked
 * for `onApplicationBootstrap` and this hook is `onModuleInit` — which is why
 * the rule is worth a test in each place rather than a memory of it.
 */
describe('TopologyEventsService boot', () => {
  function make(buildTopology: jest.Mock) {
    const service = Object.create(
      TopologyEventsService.prototype,
    ) as TopologyEventsService;
    const r = service as unknown as Record<string, unknown>;
    r.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
    r.topologyService = { isMockMode: () => false, buildTopology };
    r.gateway = { emitSnapshot: jest.fn(), emitStatus: jest.fn() };
    r.apps = new Map();
    r.servers = new Map();
    r.debouncedStatus = new Map();
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

    // Synchronous by signature: there is no promise for Nest to await, so the
    // port cannot be held behind a cluster that never answers.
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
    await Promise.resolve();
    await Promise.resolve();

    expect(
      (service as unknown as { logger: { error: jest.Mock } }).logger.error,
    ).toHaveBeenCalled();
    clearInterval(
      (service as unknown as { pollTimer: NodeJS.Timeout }).pollTimer,
    );
  });
});
