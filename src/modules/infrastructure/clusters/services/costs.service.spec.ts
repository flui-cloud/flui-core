import { CostsService, MAX_COST_MONTHS } from './costs.service';
import { CostRecordBackfillService } from './cost-record-backfill.service';
import { CostRatesService } from './cost-rates.service';
import { ClusterStatus } from '../entities/cluster.entity';

const NOW = new Date('2026-09-26T14:00:00Z');

function queryable(rows: any[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const step of ['where', 'andWhere', 'orderBy'])
    qb[step] = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => rows);
  return {
    createQueryBuilder: jest.fn(() => qb),
    update: jest.fn(async () => undefined),
  };
}

function rates() {
  const service = {
    getNodeSizes: jest.fn(async () => [
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
    ]),
    getPricing: jest.fn(async () => ({ vatRate: '19.00', serverTypes: [] })),
  };
  return new CostRatesService({
    getSupportedProviders: () => ['hetzner', 'byos'],
    getProvider: () => service,
  } as never);
}

const lifetime = (overrides: Record<string, unknown>) => ({
  id: 'iv',
  clusterId: 'c1',
  nodeId: 'n1',
  serverName: 'm',
  provider: 'hetzner',
  region: 'fsn1',
  location: 'fsn1',
  serverType: 'cx23',
  startedAt: new Date('2026-09-01T00:00:00Z'),
  endedAt: null,
  metadata: {},
  ...overrides,
});

describe('the Costs section', () => {
  it('keeps the clusters that are gone, by the name recorded on their machines', async () => {
    const service = new CostsService(
      {
        find: jest.fn(async () => [
          {
            id: 'c1',
            name: 'control',
            region: 'fsn1',
            status: ClusterStatus.READY,
          },
        ]),
      } as never,
      queryable([
        lifetime({}),
        lifetime({
          id: 'iv2',
          clusterId: 'c-gone',
          endedAt: new Date('2026-09-05T00:00:00Z'),
          metadata: { clusterName: 'wc-1' },
        }),
        lifetime({
          id: 'iv3',
          clusterId: 'c3',
          provider: 'byos',
          serverType: 'byos',
        }),
      ]) as never,
      queryable([]) as never,
      rates(),
    );

    const costs = await service.getCosts({ months: 2 }, NOW);

    expect(costs.months).toEqual(['2026-08', '2026-09']);
    const hetzner = costs.providers.find((p) => p.provider === 'hetzner')!;
    expect(hetzner.clusters.map((c) => [c.clusterName, c.removed])).toEqual([
      ['control', false],
      ['wc-1', true],
    ]);
    expect(hetzner.vatRatePercent).toBe('19');
    const byos = costs.providers.find((p) => p.provider === 'byos')!;
    expect(byos).toMatchObject({ priced: false, unpriced: 1 });
    expect(costs.totals[1].forecastNet).toBeGreaterThan(
      costs.totals[1].spentNet,
    );
    expect(costs.notes.length).toBeGreaterThan(0);
  });

  it('answers with an empty record rather than invented months', async () => {
    const service = new CostsService(
      { find: jest.fn(async () => []) } as never,
      queryable([]) as never,
      queryable([]) as never,
      rates(),
    );
    const costs = await service.getCosts({ months: 999 }, NOW);
    expect(costs.months).toHaveLength(MAX_COST_MONTHS);
    expect(costs.providers).toEqual([]);
    expect(costs.recordedSince).toBeNull();
  });
});

describe('completing the cost record of older machines', () => {
  it('stamps the cluster name and today’s list price, marked as a list price', async () => {
    const nodes = queryable([
      lifetime({}),
      lifetime({ id: 'orphan', clusterId: 'gone' }),
    ]);
    const backfill = new CostRecordBackfillService(
      { find: jest.fn(async () => [{ id: 'c1', name: 'control' }]) } as never,
      nodes as never,
      queryable([]) as never,
      rates(),
    );

    const result = await backfill.backfill(NOW);

    expect(result).toEqual({ nodesPriced: 1, volumesPriced: 0, named: 1 });
    expect(nodes.update).toHaveBeenCalledTimes(1);
    const [, { metadata }] = nodes.update.mock.calls[0] as any;
    expect(metadata.clusterName).toBe('control');
    expect(metadata.price).toMatchObject({
      hourlyNet: 0.014,
      monthlyNet: 8.71,
      basis: 'list',
    });
  });
});
