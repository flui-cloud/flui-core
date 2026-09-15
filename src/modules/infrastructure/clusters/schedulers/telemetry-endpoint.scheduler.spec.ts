// The scheduler pulls in the reconciler, which reaches Kubernetes through
// KubernetesService; the real package is ESM and Jest cannot parse it. Same
// stand-in the project's other Kubernetes specs use.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { TelemetryEndpointScheduler } from './telemetry-endpoint.scheduler';

const ok = {
  endpoint: '10.250.0.1:30100',
  updated: 0,
  unchanged: 1,
  absent: 0,
};

describe('TelemetryEndpointScheduler', () => {
  const build = (
    clusters: unknown[],
    reconcile = jest.fn(),
    reconcileMetrics = jest.fn(),
  ) => {
    reconcile.mockResolvedValue(ok);
    reconcileMetrics.mockResolvedValue({ changed: false });
    const scheduler = new TelemetryEndpointScheduler(
      { find: jest.fn().mockResolvedValue(clusters) } as never,
      { reconcile, reconcileMetrics } as never,
    );
    return { scheduler, reconcile, reconcileMetrics };
  };

  afterEach(() => {
    delete process.env.FLUI_TELEMETRY_RECONCILE;
  });

  it('does nothing at all while switched off', async () => {
    const { scheduler, reconcile } = build([{ id: 'c1', name: 'a' }]);
    await scheduler.tick();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('repoints every ready workload cluster once enabled', async () => {
    process.env.FLUI_TELEMETRY_RECONCILE = 'true';
    const { scheduler, reconcile } = build([
      { id: 'c1', name: 'a' },
      { id: 'c2', name: 'b' },
    ]);
    await scheduler.tick();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one cluster fails', async () => {
    process.env.FLUI_TELEMETRY_RECONCILE = 'true';
    const reconcile = jest
      .fn()
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValue(ok);
    const { scheduler } = build(
      [
        { id: 'c1', name: 'a' },
        { id: 'c2', name: 'b' },
      ],
      reconcile,
    );

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('never overlaps two passes', async () => {
    process.env.FLUI_TELEMETRY_RECONCILE = 'true';
    // Held at the pass's first step, so "did a second pass start" has an
    // unambiguous answer rather than depending on how far the first one got.
    let release: () => void = () => {};
    const reconcileMetrics = jest
      .fn()
      .mockImplementation(() => new Promise((r) => (release = () => r({}))));
    const { scheduler } = build(
      [{ id: 'c1', name: 'a' }],
      jest.fn(),
      reconcileMetrics,
    );

    const first = scheduler.tick();
    await scheduler.tick(); // must return immediately, not queue behind the first
    expect(reconcileMetrics).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('moves the metrics too, not only the logs', async () => {
    // They travel by different mechanisms, and the last time only one was
    // moved the logs arrived and the metrics quietly did not.
    process.env.FLUI_TELEMETRY_RECONCILE = 'true';
    const { scheduler, reconcile, reconcileMetrics } = build([
      { id: 'c1', name: 'a' },
    ]);

    await scheduler.tick();

    expect(reconcile).toHaveBeenCalledWith('c1');
    expect(reconcileMetrics).toHaveBeenCalledWith('c1');
  });

  it('still moves the logs when the metrics cannot be moved', async () => {
    process.env.FLUI_TELEMETRY_RECONCILE = 'true';
    const reconcileMetrics = jest
      .fn()
      .mockRejectedValue(new Error('no kubeconfig'));
    const { scheduler, reconcile } = build(
      [{ id: 'c1', name: 'a' }],
      jest.fn(),
      reconcileMetrics,
    );

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledWith('c1');
  });

  it('leaves the control cluster alone', async () => {
    // It ingests its own telemetry locally; there is nothing to repoint.
    process.env.FLUI_TELEMETRY_RECONCILE = 'true';
    const find = jest.fn().mockResolvedValue([]);
    const scheduler = new TelemetryEndpointScheduler(
      { find } as never,
      { reconcile: jest.fn(), reconcileMetrics: jest.fn() } as never,
    );

    await scheduler.tick();

    expect(find.mock.calls[0][0].where).toMatchObject({
      clusterType: 'workload',
      status: 'ready',
    });
  });
});
