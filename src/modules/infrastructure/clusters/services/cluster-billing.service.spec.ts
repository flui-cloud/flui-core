import { ClusterBillingService } from './cluster-billing.service';
import { CostRatesService } from './cost-rates.service';
import { NodeType } from '../entities/cluster-node.entity';

const NOW = new Date('2026-09-26T14:00:00Z');

function queryable<T>(rows: T[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const step of ['where', 'andWhere', 'orderBy']) {
    qb[step] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn(async () => rows);
  return {
    createQueryBuilder: jest.fn(() => qb),
    find: jest.fn(async () => rows.filter((r: any) => !r.endedAt)),
  };
}

function providerFactory(
  provider: string,
  sizes: unknown[],
  pricing?: unknown,
) {
  const service = {
    getNodeSizes: jest.fn(async () => sizes),
    ...(pricing ? { getPricing: jest.fn(async () => pricing) } : {}),
    getServerDetails: jest.fn(async () => null),
  };
  return {
    getSupportedProviders: () => [provider],
    getProvider: () => service,
    service,
  };
}

const HETZNER_SIZES = [
  {
    name: 'cx23',
    prices: [
      {
        location: 'fsn1',
        priceHourly: { net: '0.0140', gross: '0.0167' },
        priceMonthly: { net: '8.71', gross: '10.36' },
      },
    ],
  },
];

function interval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'iv1',
    clusterId: 'c1',
    nodeId: 'n1',
    serverName: 'control-master',
    provider: 'hetzner',
    region: 'fsn1',
    location: 'fsn1',
    serverType: 'cx23',
    nodeType: NodeType.MASTER,
    startedAt: new Date('2026-08-20T00:00:00Z'),
    endedAt: null,
    metadata: {},
    ...overrides,
  };
}

function build(
  provider: string,
  nodes: unknown[],
  factory: ReturnType<typeof providerFactory>,
  volumes: unknown[] = [],
) {
  const clusters = {
    findOne: jest.fn(async () => ({
      id: 'c1',
      name: 'control-cluster-staging-hz',
      provider,
      region: 'fsn1',
      nodes: [],
    })),
  };
  const rates = new CostRatesService(factory as never);
  return new ClusterBillingService(
    clusters as never,
    queryable(nodes) as never,
    queryable(volumes) as never,
    factory as never,
    rates,
  );
}

describe('the Pricing tab of a cluster', () => {
  it('forecasts the end of the month instead of showing the run rate twice', async () => {
    const factory = providerFactory('hetzner', HETZNER_SIZES, {
      currency: 'EUR',
      vatRate: '19.00',
      serverTypes: [],
      volumePerGbMonth: { net: '0.0440', gross: '0.0524' },
    });
    const billing = await build(
      'hetzner',
      [interval({ startedAt: new Date('2026-09-10T00:00:00Z') })],
      factory,
      [
        {
          id: 'v1',
          clusterId: 'c1',
          volumeProviderId: 'vol-1',
          provider: 'hetzner',
          region: 'fsn1',
          kind: 'shared-storage',
          sizeGb: 20,
          startedAt: new Date('2026-09-10T00:00:00Z'),
          endedAt: null,
          metadata: {},
        },
      ],
    ).getClusterBilling('c1', NOW);

    const spent = Number(billing.monthToDate.totalNet);
    const forecast = Number(billing.forecast.totalNet);
    const runRate = Number(billing.runRate.monthlyNet);
    expect(forecast).toBeGreaterThan(spent);
    expect(forecast).toBeLessThan(runRate);
    expect(billing.forecast.remainingHours).toBe(4 * 24 + 10);
    expect(billing.vat).toEqual({ included: true, ratePercent: '19' });
    expect(Number(billing.monthToDate.totalGross)).toBeGreaterThan(spent);
    expect(billing.listPricedItems).toBe(2);
  });

  it('never forecasts more than the monthly price of a node that ran all month', async () => {
    const factory = providerFactory('hetzner', HETZNER_SIZES, {
      currency: 'EUR',
      vatRate: '19.00',
      serverTypes: [],
    });
    const billing = await build(
      'hetzner',
      [interval()],
      factory,
    ).getClusterBilling('c1', NOW);
    expect(billing.forecast.totalNet).toBe('8.71');
    expect(billing.forecast.totalGross).toBe('10.36');
  });

  it('prices a node at the price it was bought at, not at today’s list price', async () => {
    const factory = providerFactory('hetzner', HETZNER_SIZES, {
      currency: 'EUR',
      vatRate: '19.00',
      serverTypes: [],
    });
    const billing = await build(
      'hetzner',
      [
        interval({
          metadata: {
            price: {
              hourlyNet: 0.01,
              hourlyGross: 0.0119,
              monthlyNet: 5,
              monthlyGross: 5.95,
              basis: 'recorded',
              pricedAt: '2026-08-20T00:00:00Z',
            },
          },
        }),
      ],
      factory,
    ).getClusterBilling('c1', NOW);
    expect(billing.forecast.totalNet).toBe('5.00');
    expect(billing.listPricedItems).toBe(0);
  });

  it('says a provider without a published VAT rate is excluding VAT', async () => {
    const factory = providerFactory('scaleway', [
      {
        name: 'DEV1-S',
        prices: [
          {
            location: 'fsn1',
            priceHourly: { net: '0.0088', gross: '0.0088' },
            priceMonthly: { net: '6.42', gross: '6.42' },
          },
        ],
      },
    ]);
    const billing = await build(
      'scaleway',
      [interval({ provider: 'scaleway', serverType: 'DEV1-S' })],
      factory,
    ).getClusterBilling('c1', NOW);
    expect(billing.vat).toEqual({ included: false, ratePercent: null });
    expect(billing.forecast.totalGross).toBe(billing.forecast.totalNet);
  });

  it('reports a machine it cannot price instead of pricing it at zero silently', async () => {
    const factory = providerFactory('hetzner', [], {
      currency: 'EUR',
      vatRate: '19.00',
      serverTypes: [],
    });
    const billing = await build(
      'hetzner',
      [interval()],
      factory,
    ).getClusterBilling('c1', NOW);
    expect(billing.unpricedItems).toBe(1);
    expect(billing.runRate.activeNodes).toBe(1);
  });
});
