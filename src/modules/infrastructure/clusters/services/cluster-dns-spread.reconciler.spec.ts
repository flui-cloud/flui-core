jest.mock('@kubernetes/client-node', () => ({}));

import { ClusterDnsSpreadReconciler } from './cluster-dns-spread.reconciler';

function setup(opts: {
  readyNodes: number;
  dns?: { replicas: number; spreadAcrossNodes: boolean } | null;
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
    readClusterDns: jest
      .fn()
      .mockResolvedValue(
        opts.dns === undefined
          ? { replicas: 1, spreadAcrossNodes: false }
          : opts.dns,
      ),
    spreadClusterDns: jest.fn().mockResolvedValue(undefined),
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
      dns: { replicas: 2, spreadAcrossNodes: true },
    });

    await expect(reconciler.reconcile('c1')).resolves.toBe('already-spread');
    expect(kubernetes.spreadClusterDns).not.toHaveBeenCalled();
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
