jest.mock('@kubernetes/client-node', () => ({}));

import { ClusterIngressReconciler } from './cluster-ingress.reconciler';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { HostnameMode } from '../enums/hostname-mode.enum';

const MASTER = '49.13.132.151';
const WORKER = '49.13.200.7';

const node = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  ready: true,
  servesIngress: true,
  externalIps: [],
  ...over,
});

function setup(opts: {
  states?: unknown;
  statesError?: Error;
  metadata?: Record<string, unknown>;
  wildcard?: string[];
  endpointRecord?: string[];
}) {
  const cluster = {
    id: 'c1',
    name: 'wc',
    masterIpAddress: MASTER,
    kubeconfigEncrypted: 'enc',
    metadata: opts.metadata ?? {},
    nodes: [
      { serverName: 'wc-master', ipAddress: MASTER },
      { serverName: 'wc-worker-1', ipAddress: WORKER },
    ],
  };
  const records = [
    ...(opts.wildcard ?? []).map((value) => ({
      name: '*.wc',
      type: DnsRecordType.A,
      value,
    })),
    ...(opts.endpointRecord ?? []).map((value) => ({
      name: 'shop.wc',
      type: DnsRecordType.A,
      value,
    })),
  ];
  const provider = {
    listRecords: jest.fn().mockResolvedValue(records),
    setRecordValues: jest.fn().mockResolvedValue([]),
  };
  const clusters = {
    findOne: jest.fn().mockResolvedValue(cluster),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const assignments = {
    find: jest.fn().mockResolvedValue([
      {
        clusterId: 'c1',
        dnsZone: {
          zoneName: 'example.com',
          providerZoneId: 'z1',
          dnsProvider: 'hetzner',
          recordTtlSeconds: 300,
        },
        endpoints: [
          {
            id: 'ep1',
            fqdn: 'shop.wc.example.com',
            hostnameMode: HostnameMode.DOMAIN,
            dnsRecordId: 'shop.wc/A:x',
            dnsRecordType: DnsRecordType.A,
          },
        ],
      },
    ]),
  };
  const kubernetes = {
    listIngressNodeStates: opts.statesError
      ? jest.fn().mockRejectedValue(opts.statesError)
      : jest.fn().mockResolvedValue(opts.states ?? []),
  };
  const zoneReconciliation = { fanOutRecordToReplicas: jest.fn() };
  const reconciler = new ClusterIngressReconciler(
    clusters as never,
    assignments as never,
    kubernetes as never,
    { decrypt: (v: string) => v } as never,
    { getDnsProviderOrFail: () => provider } as never,
    zoneReconciliation as never,
  );
  return { reconciler, provider, clusters };
}

describe('moving a cluster’s names to the nodes that take traffic', () => {
  it('adds a worker that became ready to the application record and the cluster wildcard', async () => {
    const { reconciler, provider, clusters } = setup({
      states: [node('wc-master'), node('wc-worker-1')],
      wildcard: [MASTER],
      endpointRecord: [MASTER],
    });

    const outcome = await reconciler.reconcile('c1');

    expect(outcome).toMatchObject({
      state: 'moved',
      addresses: [MASTER, WORKER],
      records: 2,
    });
    for (const name of ['*.wc', 'shop.wc']) {
      expect(provider.setRecordValues).toHaveBeenCalledWith(
        expect.objectContaining({ name, values: [MASTER, WORKER], ttl: 60 }),
      );
    }
    expect(clusters.update).toHaveBeenCalledWith('c1', {
      metadata: expect.objectContaining({
        ingressAddresses: expect.objectContaining({
          addresses: [MASTER, WORKER],
        }),
      }),
    });
  });

  it('takes a node that stopped being ready out of the names', async () => {
    const { reconciler, provider } = setup({
      states: [node('wc-master'), node('wc-worker-1', { ready: false })],
      metadata: {
        ingressAddresses: { addresses: [MASTER, WORKER], measuredAt: 'x' },
      },
      wildcard: [MASTER, WORKER],
      endpointRecord: [MASTER, WORKER],
    });

    await reconciler.reconcile('c1');

    expect(provider.setRecordValues).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shop.wc', values: [MASTER] }),
    );
  });

  it('leaves a wildcard that points somewhere else alone', async () => {
    const { reconciler, provider } = setup({
      states: [node('wc-master'), node('wc-worker-1')],
      wildcard: ['203.0.113.9'],
      endpointRecord: [MASTER],
    });

    await reconciler.reconcile('c1');

    expect(provider.setRecordValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: '*.wc' }),
    );
  });

  it('publishes nothing when no node can take traffic', async () => {
    const { reconciler, provider, clusters } = setup({
      states: [node('wc-master', { ready: false })],
      endpointRecord: [MASTER],
    });

    const outcome = await reconciler.reconcile('c1');

    expect(outcome.state).toBe('unmeasured');
    expect(provider.setRecordValues).not.toHaveBeenCalled();
    expect(clusters.update).not.toHaveBeenCalled();
  });

  it('keeps the last answer when the cluster cannot be read', async () => {
    const { reconciler, provider } = setup({
      statesError: new Error('connect ETIMEDOUT'),
      endpointRecord: [MASTER],
    });

    const outcome = await reconciler.reconcile('c1');

    expect(outcome).toEqual({
      state: 'unmeasured',
      reason: 'connect ETIMEDOUT',
    });
    expect(provider.setRecordValues).not.toHaveBeenCalled();
  });

  it('writes nothing when the set has not changed', async () => {
    const { reconciler, provider, clusters } = setup({
      states: [node('wc-master'), node('wc-worker-1')],
      metadata: {
        ingressAddresses: { addresses: [MASTER, WORKER], measuredAt: 'x' },
      },
      endpointRecord: [MASTER, WORKER],
    });

    const outcome = await reconciler.reconcile('c1');

    expect(outcome.state).toBe('unchanged');
    expect(provider.setRecordValues).not.toHaveBeenCalled();
    expect(clusters.update).not.toHaveBeenCalled();
  });
});
