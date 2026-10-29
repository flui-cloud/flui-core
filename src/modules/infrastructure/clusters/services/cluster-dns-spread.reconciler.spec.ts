jest.mock('@kubernetes/client-node', () => ({}));

import {
  ClusterDnsSpreadReconciler,
  dnsNeedsRespread,
} from './cluster-dns-spread.reconciler';

function setup(opts: {
  readyNodes: number;
  dns?: {
    replicas: number;
    spreadAcrossNodes: boolean;
    spreadAcrossZones?: boolean;
    podZones?: string[];
    readyZones?: string[];
  } | null;
  fail?: Error;
}) {
  const kubernetes = {
    listIngressNodeStates: opts.fail
      ? jest.fn().mockRejectedValue(opts.fail)
      : jest.fn().mockResolvedValue(
          Array.from({ length: 3 }, (_, i) => ({
            name: `n${i}`,
            ready: i < opts.readyNodes,
            servesIngress: true,
            externalIps: [],
          })),
        ),
    readClusterDns: jest.fn().mockResolvedValue(
      opts.dns === undefined
        ? {
            replicas: 1,
            spreadAcrossNodes: false,
            podZones: [],
            readyZones: [],
          }
        : opts.dns && { podZones: [], readyZones: [], ...opts.dns },
    ),
    spreadClusterDns: jest.fn().mockResolvedValue(undefined),
    respreadClusterDns: jest.fn().mockResolvedValue(undefined),
  };
  const reconciler = new ClusterDnsSpreadReconciler(
    {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'c1', name: 'wc', kubeconfigEncrypted: 'k' }),
    } as never,
    kubernetes as never,
    { decrypt: (v: string) => v } as never,
  );
  return { reconciler, kubernetes };
}

describe('keeping the cluster DNS on two nodes', () => {
  it('runs two copies spread across nodes once two nodes are ready', async () => {
    const { reconciler, kubernetes } = setup({ readyNodes: 2 });

    await expect(reconciler.reconcile('c1')).resolves.toBe('spread');
    expect(kubernetes.spreadClusterDns).toHaveBeenCalledWith('k', 2);
  });

  it('puts the spread back after K3s rewrote the manifest', async () => {
    const { reconciler, kubernetes } = setup({
      readyNodes: 3,
      dns: { replicas: 2, spreadAcrossNodes: false },
    });

    await expect(reconciler.reconcile('c1')).resolves.toBe('spread');
    expect(kubernetes.spreadClusterDns).toHaveBeenCalled();
  });

  it('does nothing when it is already right', async () => {
    const { reconciler, kubernetes } = setup({
      readyNodes: 2,
      dns: { replicas: 2, spreadAcrossNodes: true, spreadAcrossZones: true },
    });

    await expect(reconciler.reconcile('c1')).resolves.toBe('already-spread');
    expect(kubernetes.spreadClusterDns).not.toHaveBeenCalled();
  });

  it('adds locations to a DNS spread only across nodes', async () => {
    const { reconciler, kubernetes } = setup({
      readyNodes: 3,
      dns: { replicas: 2, spreadAcrossNodes: true, spreadAcrossZones: false },
    });

    await expect(reconciler.reconcile('c1')).resolves.toBe('spread');
    expect(kubernetes.spreadClusterDns).toHaveBeenCalledWith('k', 2);
  });

  it('leaves a single-node cluster alone', async () => {
    const { reconciler, kubernetes } = setup({ readyNodes: 1 });

    await expect(reconciler.reconcile('c1')).resolves.toBe('single-node');
    expect(kubernetes.spreadClusterDns).not.toHaveBeenCalled();
  });

  it('never lowers a count somebody raised', async () => {
    const { reconciler, kubernetes } = setup({
      readyNodes: 3,
      dns: { replicas: 3, spreadAcrossNodes: false },
    });

    await reconciler.reconcile('c1');
    expect(kubernetes.spreadClusterDns).toHaveBeenCalledWith('k', 3);
  });

  it('reports an unreachable cluster without throwing', async () => {
    const { reconciler } = setup({
      readyNodes: 2,
      fail: new Error('ETIMEDOUT'),
    });

    await expect(reconciler.reconcile('c1')).resolves.toBe('unreachable');
  });
});

describe('moving the cluster DNS out of a single location', () => {
  const now = Date.parse('2026-10-29T08:00:00Z');

  it('restarts it when every copy sits in one location and another has room', async () => {
    const { reconciler, kubernetes } = setup({
      readyNodes: 3,
      dns: {
        replicas: 2,
        spreadAcrossNodes: true,
        spreadAcrossZones: true,
        podZones: ['fsn1', 'fsn1'],
        readyZones: ['fsn1', 'nbg1', 'hel1'],
      },
    });
    await expect(reconciler.reconcile('c1')).resolves.toBe('respread');
    expect(kubernetes.respreadClusterDns).toHaveBeenCalled();
  });

  it('leaves copies already in two locations, or a cluster with one location', () => {
    expect(
      dnsNeedsRespread(
        { podZones: ['fsn1', 'nbg1'], readyZones: ['fsn1', 'nbg1'] },
        now,
      ),
    ).toBe(false);
    expect(
      dnsNeedsRespread(
        { podZones: ['fsn1', 'fsn1'], readyZones: ['fsn1'] },
        now,
      ),
    ).toBe(false);
  });

  it('waits an hour before trying again', () => {
    const dns = { podZones: ['fsn1', 'fsn1'], readyZones: ['fsn1', 'nbg1'] };
    expect(
      dnsNeedsRespread({ ...dns, respreadAt: '2026-10-29T07:30:00Z' }, now),
    ).toBe(false);
    expect(
      dnsNeedsRespread({ ...dns, respreadAt: '2026-10-29T06:30:00Z' }, now),
    ).toBe(true);
  });
});
