import {
  ControlMembershipService,
  MEMBER_REWRITE_BUDGET_MS,
} from './control-membership.service';

const build = (end: any, applyCluster = jest.fn().mockResolvedValue([])) => {
  const hub = {
    ensureControlEnd: jest.fn().mockResolvedValue(end),
    withdrawControlNode: jest.fn().mockResolvedValue(true),
  };
  const svc = new ControlMembershipService(
    {
      find: jest.fn().mockResolvedValue([
        { id: 'wl-1', name: 'demo' },
        { id: 'wl-2', name: 'other' },
      ]),
    } as any,
    hub as any,
    { applyCluster } as any,
  );
  return { svc, hub, applyCluster };
};

describe('a control node joining or leaving reaches the members in the same operation', () => {
  beforeEach(() => {
    process.env.FLUI_WG_ENABLED = 'true';
  });
  afterEach(() => {
    process.env.FLUI_WG_ENABLED = 'false';
  });

  it('brings the new end up, then rewrites every enrolled member', async () => {
    const { svc, hub, applyCluster } = build({
      nodes: [{ host: '1.1.1.1', applied: true }],
    });

    expect(await svc.afterControlNodesJoined()).toEqual([]);

    expect(hub.ensureControlEnd).toHaveBeenCalled();
    expect(applyCluster).toHaveBeenCalledWith('wl-1', { enrolledOnly: true });
    expect(applyCluster).toHaveBeenCalledWith('wl-2', { enrolledOnly: true });
  });

  it('says which control node and which member did not converge', async () => {
    const { svc } = build(
      {
        nodes: [
          { host: '1.1.1.1', applied: true },
          { host: '2.2.2.2', applied: false, error: 'cannot run WireGuard' },
        ],
      },
      jest.fn().mockResolvedValue([{ host: '9.9.9.9', error: 'ssh timeout' }]),
    );

    const problems = await svc.afterControlNodesJoined();

    expect(problems).toContain('control node 2.2.2.2: cannot run WireGuard');
    expect(problems).toContain('demo/9.9.9.9: ssh timeout');
  });

  it('withdraws the leaving node before rewriting the members', async () => {
    const order: string[] = [];
    const { svc, hub, applyCluster } = build({ nodes: [] });
    hub.withdrawControlNode.mockImplementation(async () => {
      order.push('withdraw');
      return true;
    });
    applyCluster.mockImplementation(async () => {
      order.push('apply');
      return [];
    });

    await svc.beforeControlNodeRemoved('worker-1');

    expect(order).toEqual(['withdraw', 'apply', 'apply']);
  });

  it('touches no member when the leaving node was not on the network', async () => {
    const { svc, hub, applyCluster } = build({ nodes: [] });
    hub.withdrawControlNode.mockResolvedValue(false);

    await svc.beforeControlNodeRemoved('worker-1');

    expect(applyCluster).not.toHaveBeenCalled();
  });

  it('does not hold the operation past its budget: it reports the rewrite as still running and lets it finish', async () => {
    jest.useFakeTimers();
    try {
      const finishers: Array<(v: unknown[]) => void> = [];
      const applyCluster = jest.fn(
        () => new Promise<unknown[]>((resolve) => finishers.push(resolve)),
      );
      const { svc } = build({ nodes: [] }, applyCluster);

      const pending = svc.beforeControlNodeRemoved('worker-1');
      await jest.advanceTimersByTimeAsync(MEMBER_REWRITE_BUDGET_MS);

      expect(await pending).toEqual([
        expect.stringContaining('the next sweep finishes it'),
      ]);
      finishers.forEach((finish) => finish([]));
      await jest.advanceTimersByTimeAsync(0);
      expect(applyCluster).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('turns a failure to list the members into a problem, never a thrown operation', async () => {
    const { svc } = build({ nodes: [] });
    (svc as any).clusters.find.mockRejectedValue(new Error('db down'));
    expect(await svc.beforeControlNodeRemoved('worker-1')).toEqual([
      'members: db down',
    ]);
  });

  it('does nothing while the network is off', async () => {
    process.env.FLUI_WG_ENABLED = 'false';
    const { svc, hub } = build({ nodes: [] });
    expect(await svc.afterControlNodesJoined()).toEqual([]);
    expect(await svc.beforeControlNodeRemoved('w')).toEqual([]);
    expect(hub.ensureControlEnd).not.toHaveBeenCalled();
    expect(hub.withdrawControlNode).not.toHaveBeenCalled();
  });
});
