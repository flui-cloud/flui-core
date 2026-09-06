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
