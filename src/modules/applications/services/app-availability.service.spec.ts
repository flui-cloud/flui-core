jest.mock('@kubernetes/client-node', () => ({}));

import { AppAvailabilityService } from './app-availability.service';
import { HostnameMode } from '../../dns/enums/hostname-mode.enum';

const pod = (node: string, ready = true, deleting = false) => ({
  metadata: deleting ? { deletionTimestamp: new Date() } : {},
  spec: { nodeName: node },
  status: {
    conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
  },
});

function serviceWith(opts: {
  pods: unknown[];
  bindings?: Array<{ claimName: string; node: string | null }>;
  ingress?: string[];
  endpoints?: Array<{ fqdn: string; hostnameMode: HostnameMode }>;
  app?: Record<string, unknown>;
}) {
  return new AppAvailabilityService(
    {
      findByIdLite: jest.fn().mockResolvedValue({
        id: 'a1',
        clusterId: 'c1',
        k8sNamespace: 'user-x',
        replicas: 2,
        ...opts.app,
      }),
    } as never,
    { findByApplicationId: jest.fn().mockResolvedValue([]) } as never,
    {
      findOne: jest.fn().mockResolvedValue({
        id: 'c1',
        kubeconfigEncrypted: 'k',
        masterIpAddress: '1.1.1.1',
        metadata: opts.ingress
          ? { ingressAddresses: { addresses: opts.ingress, measuredAt: 'x' } }
          : {},
      }),
    } as never,
    { find: jest.fn().mockResolvedValue(opts.endpoints ?? []) } as never,
    {
      listPodsByLabel: jest.fn().mockResolvedValue(opts.pods),
      listVolumeNodeBindings: jest.fn().mockResolvedValue(opts.bindings ?? []),
    } as never,
    { decrypt: (v: string) => v } as never,
    {
      resolveForApplication: jest
        .fn()
        .mockResolvedValue(
          (opts.bindings ?? []).map((b) => ({ name: b.claimName })),
        ),
    } as never,
  );
}

describe('the availability of one application, read from its cluster', () => {
  it('counts only ready copies that are not shutting down', async () => {
    const result = await serviceWith({
      pods: [pod('n1'), pod('n2', false), pod('n2', true, true)],
      ingress: ['1.1.1.1', '2.2.2.2'],
    }).forApplication('a1');

    expect(result.reasons.map((r) => r.code)).toEqual(['copies_on_one_node']);
  });

  it('names the volume bound to a node', async () => {
    const result = await serviceWith({
      pods: [pod('n1'), pod('n2')],
      bindings: [{ claimName: 'shop-data', node: 'n1' }],
      ingress: ['1.1.1.1', '2.2.2.2'],
    }).forApplication('a1');

    expect(result.reasons).toEqual([
      expect.objectContaining({
        code: 'volume_on_one_node',
        message: expect.stringContaining('shop-data'),
      }),
    ]);
  });

  it('counts the nodes that take traffic from what the cluster recorded', async () => {
    const result = await serviceWith({
      pods: [pod('n1'), pod('n2')],
      endpoints: [
        { fqdn: 'shop.example.com', hostnameMode: HostnameMode.DOMAIN },
      ],
    }).forApplication('a1');

    expect(result.reasons.map((r) => r.code)).toEqual(['single_ingress_node']);
  });

  it('is highly available when nothing stands in the way', async () => {
    const result = await serviceWith({
      pods: [pod('n1'), pod('n2')],
      ingress: ['1.1.1.1', '2.2.2.2'],
      endpoints: [
        { fqdn: 'shop.example.com', hostnameMode: HostnameMode.DOMAIN },
      ],
    }).forApplication('a1');

    expect(result).toEqual({ highlyAvailable: true, reasons: [] });
  });
});

describe('the availability of a database that moved to a highly available cluster', () => {
  const ha = {
    engine: 'cnpg',
    cluster: 'orders-db-ha',
    durability: 'required',
    instances: 2,
    state: 'active',
    since: 'x',
  };

  it('survives losing a worker once its instances run on two nodes', async () => {
    const result = await serviceWith({
      pods: [pod('worker-1'), pod('worker-2')],
      bindings: [
        { claimName: 'orders-db-ha-1', node: 'worker-1' },
        { claimName: 'orders-db-ha-2', node: 'worker-2' },
        { claimName: 'data-orders-db-0', node: 'worker-2' },
      ],
      app: { replicas: 1, persistenceScope: 'dedicated', databaseHa: ha },
    }).forApplication('a1');
    expect(result).toEqual({ highlyAvailable: true, reasons: [] });
  });

  it('says so while only one instance is ready', async () => {
    const result = await serviceWith({
      pods: [pod('worker-1'), pod('worker-2', false)],
      app: { replicas: 1, persistenceScope: 'dedicated', databaseHa: ha },
    }).forApplication('a1');
    expect(result.highlyAvailable).toBe(false);
    expect(result.reasons.map((r) => r.code)).toEqual(['copies_on_one_node']);
  });

  it('is still a single database while the copy is being built', async () => {
    const result = await serviceWith({
      pods: [pod('worker-2')],
      app: {
        replicas: 1,
        persistenceScope: 'dedicated',
        databaseHa: { ...ha, state: 'copying' },
      },
    }).forApplication('a1');
    expect(result.reasons.map((r) => r.code)).toEqual([
      'single_copy',
      'dedicated_placement',
    ]);
  });
});
