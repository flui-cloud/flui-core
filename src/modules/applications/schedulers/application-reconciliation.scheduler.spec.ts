// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { ApplicationReconciliationScheduler } from './application-reconciliation.scheduler';

describe('the tick that re-reads how applications are doing', () => {
  const build = (reconcileAll: jest.Mock) =>
    new ApplicationReconciliationScheduler({ reconcileAll } as never);

  it('asks the cluster', async () => {
    const reconcileAll = jest.fn().mockResolvedValue(undefined);
    await build(reconcileAll).tick();
    expect(reconcileAll).toHaveBeenCalledTimes(1);
  });

  /**
   * One K8s read per resource per application, in sequence. On a cluster with
   * many applications, or one reached over the network, a cycle can outlast its
   * own interval — and two of them running at once double the load to learn the
   * same thing.
   */
  it('skips a tick while the previous one is still going', async () => {
    let release!: () => void;
    const reconcileAll = jest
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const scheduler = build(reconcileAll);

    const first = scheduler.tick();
    await scheduler.tick();
    expect(reconcileAll).toHaveBeenCalledTimes(1);

    release();
    await first;
    await scheduler.tick();
    expect(reconcileAll).toHaveBeenCalledTimes(2);
  });

  /**
   * A cluster that cannot be reached must not stop the next cycle: the guard is
   * released on the way out, error or not, or one failure ends the reconciler
   * for the life of the process.
   */
  it('keeps ticking after a cycle throws', async () => {
    const reconcileAll = jest
      .fn()
      .mockRejectedValueOnce(new Error('cluster unreachable'))
      .mockResolvedValue(undefined);
    const scheduler = build(reconcileAll);

    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.tick();
    expect(reconcileAll).toHaveBeenCalledTimes(2);
  });
});
