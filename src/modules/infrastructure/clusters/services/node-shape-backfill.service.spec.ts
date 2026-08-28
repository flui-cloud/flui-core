import { NodeShapeBackfillService } from './node-shape-backfill.service';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';

type Node = Partial<ClusterNodeEntity>;
type Interval = Partial<NodeBillableIntervalEntity>;

const cluster = (over: Partial<ClusterEntity> = {}): ClusterEntity =>
  ({
    id: 'c1',
    provider: 'hetzner',
    region: 'fsn1',
    nodeSize: 'cx32',
    ...over,
  }) as ClusterEntity;

const build = (opts: {
  nodes: Node[];
  intervals?: Interval[];
  serverType?: string | null;
  location?: string;
  supported?: string[];
  price?: number | null;
}) => {
  const saved: Node[] = [];
  const nodeRepository = {
    find: jest.fn(async () => opts.nodes),
    save: jest.fn(async (n: Node) => {
      saved.push(n);
      return n;
    }),
  };
  const intervalRepository = {
    findOne: jest.fn(async ({ where }: { where: { nodeId: string } }) => {
      return (opts.intervals ?? []).find((i) => i.nodeId === where.nodeId);
    }),
  };
  const getServerDetailsAsDto = jest.fn(async () =>
    opts.serverType === undefined
      ? null
      : { server_type: opts.serverType, location: opts.location },
  );
  const providerFactory = {
    getSupportedProviders: () => opts.supported ?? ['hetzner'],
    getProvider: () => ({ getServerDetailsAsDto }),
  };
  const nodePriceService = {
    resolveHourlyEur: jest.fn(async () => opts.price ?? null),
  };

  const service = new NodeShapeBackfillService(
    {} as never,
    nodeRepository as never,
    intervalRepository as never,
    providerFactory as never,
    nodePriceService as never,
  );
  return { service, saved, getServerDetailsAsDto, nodePriceService };
};

describe('NodeShapeBackfillService', () => {
  it('takes the shape from the billable interval, which is per node', async () => {
    const { service, saved } = build({
      nodes: [{ id: 'n1', provider: 'hetzner' }],
      intervals: [
        {
          nodeId: 'n1',
          provider: 'hetzner',
          region: 'nbg1',
          serverType: 'cpx31',
        },
      ],
    });

    const result = await service.backfill([cluster()]);

    expect(result.fromIntervals).toBe(1);
    expect(saved[0]).toMatchObject({ serverType: 'cpx31', region: 'nbg1' });
  });

  it('prefers the interval location over its region when both are recorded', async () => {
    const { service, saved } = build({
      nodes: [{ id: 'n1', provider: 'hetzner' }],
      intervals: [
        {
          nodeId: 'n1',
          provider: 'hetzner',
          region: 'nbg1',
          location: 'nbg1-dc3',
          serverType: 'cpx31',
        },
      ],
    });

    await service.backfill([cluster()]);

    expect(saved[0].region).toBe('nbg1-dc3');
  });

  it('refuses the placeholder BYOS writes into region and serverType', async () => {
    const { service, saved, getServerDetailsAsDto } = build({
      nodes: [{ id: 'n1', provider: 'byos', providerResourceId: 'host-1' }],
      intervals: [
        {
          nodeId: 'n1',
          provider: 'byos',
          region: 'byos',
          serverType: 'byos',
        },
      ],
      supported: ['hetzner'],
    });

    const result = await service.backfill([cluster({ provider: 'byos' })]);

    expect(result.fromIntervals).toBe(0);
    expect(getServerDetailsAsDto).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('asks the provider when no interval carries a real shape', async () => {
    const { service, saved, getServerDetailsAsDto } = build({
      nodes: [{ id: 'n1', provider: 'hetzner', providerResourceId: 's-9' }],
      serverType: 'cx43',
      location: 'hel1',
    });

    const result = await service.backfill([cluster()]);

    expect(getServerDetailsAsDto).toHaveBeenCalledWith('s-9');
    expect(result.fromProvider).toBe(1);
    expect(saved[0]).toMatchObject({ serverType: 'cx43', region: 'hel1' });
  });

  it('never asks a provider Flui has no client for', async () => {
    const { service, getServerDetailsAsDto } = build({
      nodes: [{ id: 'n1', provider: 'byos', providerResourceId: 'host-1' }],
      supported: ['hetzner', 'scaleway'],
    });

    await service.backfill([cluster({ provider: 'byos' })]);

    expect(getServerDetailsAsDto).not.toHaveBeenCalled();
  });

  it('leaves an unknown shape null rather than borrowing the cluster nodeSize', async () => {
    const { service, saved } = build({
      nodes: [{ id: 'n1', provider: 'byos' }],
      supported: [],
    });

    await service.backfill([cluster({ provider: 'byos' })]);

    expect(saved).toHaveLength(0);
  });

  it('prices a node only once its size is known', async () => {
    const { service, saved, nodePriceService } = build({
      nodes: [{ id: 'n1', provider: 'hetzner', serverType: 'cx32' }],
      price: 0.0092,
    });

    const result = await service.backfill([cluster()]);

    expect(nodePriceService.resolveHourlyEur).toHaveBeenCalledWith(
      'hetzner',
      'cx32',
      undefined,
    );
    expect(result.priced).toBe(1);
    expect(saved[0].hourlyPriceEur).toBe(0.0092);
  });

  it('leaves the price null when the catalogue has none', async () => {
    const { service, saved } = build({
      nodes: [{ id: 'n1', provider: 'byos', serverType: null }],
      supported: [],
      price: null,
    });

    const result = await service.backfill([cluster({ provider: 'byos' })]);

    expect(result.priced).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('keeps going when one node throws', async () => {
    const { service } = build({
      nodes: [
        { id: 'n1', provider: 'hetzner', providerResourceId: 's-1' },
        { id: 'n2', provider: 'hetzner', serverType: 'cx32' },
      ],
      price: 0.01,
    });

    await expect(service.backfill([cluster()])).resolves.toMatchObject({
      priced: 1,
    });
  });
});
