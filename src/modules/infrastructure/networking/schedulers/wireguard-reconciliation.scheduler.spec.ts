import { WireGuardReconciliationScheduler } from './wireguard-reconciliation.scheduler';

const ok = {
  enrolled: 0,
  applied: 0,
  revoked: 0,
  unsupported: 0,
  failed: [],
};

describe('WireGuardReconciliationScheduler', () => {
  const build = (
    clusters: any[],
    reconcileCluster = jest.fn(),
    ensureControlEnd = jest.fn().mockResolvedValue({
      address: '10.250.0.1',
      publicKey: 'k',
      host: '1.1.1.1',
      applied: true,
    }),
  ) => {
    reconcileCluster.mockResolvedValue(ok);
    const revokeOrphanPeers = jest.fn().mockResolvedValue(0);
    const scheduler = new WireGuardReconciliationScheduler(
      { find: jest.fn().mockResolvedValue(clusters) } as any,
      { reconcileCluster } as any,
      { ensureControlEnd, revokeOrphanPeers } as any,
    );
    return { scheduler, reconcileCluster, ensureControlEnd, revokeOrphanPeers };
  };

  afterEach(() => {
    delete process.env.FLUI_WG_ENABLED;
  });

  it('does nothing at all while the overlay is switched off', async () => {
    const { scheduler, reconcileCluster } = build([{ id: 'c1', name: 'a' }]);
    await scheduler.tick();
    expect(reconcileCluster).not.toHaveBeenCalled();
  });

  it('reconciles every ready workload cluster once enabled', async () => {
    process.env.FLUI_WG_ENABLED = 'true';
    const { scheduler, reconcileCluster } = build([
      { id: 'c1', name: 'a' },
      { id: 'c2', name: 'b' },
    ]);
    await scheduler.tick();
    expect(reconcileCluster).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one cluster fails', async () => {
    // An unreachable host is the ordinary case this loop exists to recover
    // from, not a reason to abandon the pass.
    process.env.FLUI_WG_ENABLED = 'true';
    const reconcileCluster = jest
      .fn()
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValue(ok);
    const { scheduler } = build(
      [
        { id: 'c1', name: 'a' },
        { id: 'c2', name: 'b' },
      ],
      reconcileCluster,
    );

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(reconcileCluster).toHaveBeenCalledTimes(2);
  });

  it('never overlaps two passes', async () => {
    // SSH to every node of every cluster is slow; two passes would fight over
    // the same interfaces. The pass is held at its first step — raising the
    // control's end — so "did a second pass start" has an unambiguous answer
    // rather than depending on how far the first one got.
    process.env.FLUI_WG_ENABLED = 'true';
    let release: () => void = () => {};
    const ensureControlEnd = jest
      .fn()
      .mockImplementation(() => new Promise((r) => (release = () => r(null))));
    const { scheduler } = build(
      [{ id: 'c1', name: 'a' }],
      jest.fn(),
      ensureControlEnd,
    );

    const first = scheduler.tick();
    await scheduler.tick(); // must return immediately, not queue behind the first
    expect(ensureControlEnd).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('raises the control’s own end before anything else', async () => {
    // Members dial the control: until its end is up there is no overlay for
    // any of them to join.
    process.env.FLUI_WG_ENABLED = 'true';
    const order: string[] = [];
    const ensureControlEnd = jest.fn().mockImplementation(async () => {
      order.push('control');
      return {
        address: '10.250.0.1',
        publicKey: 'k',
        host: 'h',
        applied: true,
      };
    });
    const reconcileCluster = jest.fn();
    const { scheduler } = build(
      [{ id: 'c1', name: 'a' }],
      reconcileCluster,
      ensureControlEnd,
    );
    // After build: it installs a default resolution on whatever mock it is
    // given, which would replace this one.
    reconcileCluster.mockImplementation(async () => {
      order.push('workload');
      return ok;
    });

    await scheduler.tick();

    expect(order).toEqual(['control', 'workload']);
  });

  it('keeps going when the control end cannot be raised', async () => {
    // The workload loop refuses on its own when the control has no key, and
    // one unreachable control should not also cost the rest of the pass.
    process.env.FLUI_WG_ENABLED = 'true';
    const ensureControlEnd = jest
      .fn()
      .mockRejectedValue(new Error('unreachable'));
    const { scheduler, reconcileCluster } = build(
      [{ id: 'c1', name: 'a' }],
      jest.fn(),
      ensureControlEnd,
    );

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(reconcileCluster).toHaveBeenCalledTimes(1);
  });

  it('withdraws departed peers before the hub config is written', async () => {
    // The hub's config lists the members it knows; writing it first would keep
    // a destroyed cluster's nodes on the interface for another whole pass.
    process.env.FLUI_WG_ENABLED = 'true';
    const order: string[] = [];
    const { scheduler } = build(
      [],
      jest.fn(),
      jest.fn().mockImplementation(async () => {
        order.push('hub');
        return {
          address: '10.250.0.1',
          publicKey: 'k',
          host: '1.1.1.1',
          applied: true,
        };
      }),
    );
    (scheduler as any).hub.revokeOrphanPeers = jest
      .fn()
      .mockImplementation(async () => {
        order.push('revoke');
        return 0;
      });

    await scheduler.tick();

    expect(order).toEqual(['revoke', 'hub']);
  });

  it('only looks at ready workload clusters', async () => {
    process.env.FLUI_WG_ENABLED = 'true';
    const find = jest.fn().mockResolvedValue([]);
    const scheduler = new WireGuardReconciliationScheduler(
      { find } as any,
      { reconcileCluster: jest.fn() } as any,
      {
        ensureControlEnd: jest.fn().mockResolvedValue(undefined),
        revokeOrphanPeers: jest.fn().mockResolvedValue(0),
      } as any,
    );

    await scheduler.tick();

    const where = find.mock.calls[0][0].where;
    expect(where.status).toBe('ready');
    expect(JSON.stringify(where.clusterType)).toContain('workload');
  });
});
