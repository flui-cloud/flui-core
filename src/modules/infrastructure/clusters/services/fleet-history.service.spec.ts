import {
  FleetHistoryService,
  FleetInterval,
  resolveShape,
  sampleFleet,
  UNKNOWN_SHAPE,
} from './fleet-history.service';
import { NodeType } from '../entities/cluster-node.entity';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const at = (iso: string): number => Date.parse(iso);

const interval = (over: Partial<FleetInterval> = {}): FleetInterval => ({
  startedAt: at('2026-08-01T00:00:00Z'),
  endedAt: null,
  shape: 'cx23',
  hourlyEur: 0.0056,
  ...over,
});

describe('resolveShape', () => {
  it('keeps a real server type', () => {
    expect(resolveShape({ provider: 'hetzner', serverType: 'cx32' })).toBe(
      'cx32',
    );
  });

  /*
   * The intervals write the provider's own name where BYOS had nothing to
   * record. Left alone it would draw a band called `byos` next to `cx32`.
   */
  it('reduces a provider-name placeholder to unknown', () => {
    expect(resolveShape({ provider: 'byos', serverType: 'byos' })).toBe(
      UNKNOWN_SHAPE,
    );
    expect(resolveShape({ provider: 'Contabo', serverType: 'contabo' })).toBe(
      UNKNOWN_SHAPE,
    );
  });

  it('reduces an absent server type to unknown', () => {
    expect(resolveShape({ provider: 'hetzner', serverType: null })).toBe(
      UNKNOWN_SHAPE,
    );
    expect(resolveShape({ provider: 'hetzner', serverType: '  ' })).toBe(
      UNKNOWN_SHAPE,
    );
  });
});

describe('sampleFleet', () => {
  const from = at('2026-08-01T00:00:00Z');
  const to = at('2026-08-05T00:00:00Z');

  it('counts one series per shape rather than one total', () => {
    const points = sampleFleet(
      [
        interval({ shape: 'cx23' }),
        interval({ shape: 'cx23' }),
        interval({ shape: 'cpx41', hourlyEur: 0.0389 }),
      ],
      from,
      to,
      DAY,
    );

    expect(points).toHaveLength(5);
    expect(points[0].byShape).toEqual({ cx23: 2, cpx41: 1 });
    expect(points[0].nodes).toBe(3);
  });

  it('follows a node in and out of the fleet', () => {
    const points = sampleFleet(
      [
        interval({ shape: 'cx23' }),
        interval({
          shape: 'cpx41',
          startedAt: at('2026-08-03T00:00:00Z'),
          endedAt: at('2026-08-04T00:00:00Z'),
        }),
      ],
      from,
      to,
      DAY,
    );

    expect(points.map((p) => p.nodes)).toEqual([1, 1, 2, 1, 1]);
    expect(points[2].byShape).toEqual({ cx23: 1, cpx41: 1 });
    expect(points[3].byShape).toEqual({ cx23: 1 });
  });

  it('sums the hourly cost of the shapes that are alive', () => {
    const points = sampleFleet(
      [
        interval({ shape: 'cx23', hourlyEur: 0.0056 }),
        interval({ shape: 'cpx41', hourlyEur: 0.0389 }),
      ],
      from,
      from,
      DAY,
    );

    expect(points[0].hourlyEur).toBe(0.0445);
  });

  /*
   * A node with no price contributes nothing rather than zero: the machine is
   * the operator's own, and folding it in at zero would make a BYOS fleet read
   * as free instead of as unpriced.
   */
  it('counts an unpriced node without adding it to the cost', () => {
    const points = sampleFleet(
      [
        interval({ shape: 'cx23', hourlyEur: 0.0056 }),
        interval({ shape: UNKNOWN_SHAPE, hourlyEur: null }),
      ],
      from,
      from,
      DAY,
    );

    expect(points[0].nodes).toBe(2);
    expect(points[0].unpricedNodes).toBe(1);
    expect(points[0].hourlyEur).toBe(0.0056);
  });

  it('treats an interval that ends exactly on a sample as gone', () => {
    const points = sampleFleet(
      [interval({ endedAt: at('2026-08-02T00:00:00Z') })],
      from,
      to,
      DAY,
    );

    expect(points.map((p) => p.nodes)).toEqual([1, 0, 0, 0, 0]);
  });

  it('has an empty fleet before anything started', () => {
    const points = sampleFleet(
      [interval({ startedAt: at('2026-08-04T00:00:00Z') })],
      from,
      to,
      DAY,
    );

    expect(points[0].byShape).toEqual({});
    expect(points[0].nodes).toBe(0);
    expect(points[4].nodes).toBe(1);
  });
});

describe('FleetHistoryService — intervals whose node is gone', () => {
  const CLUSTER = 'cluster-1';

  const row = (
    over: Partial<NodeBillableIntervalEntity> = {},
  ): NodeBillableIntervalEntity =>
    ({
      id: 'i-1',
      clusterId: CLUSTER,
      nodeId: 'n-1',
      serverName: 'worker-1',
      provider: 'hetzner',
      region: 'fsn1',
      location: 'fsn1',
      serverType: 'cx23',
      nodeType: NodeType.WORKER,
      startedAt: new Date(Date.now() - 3 * DAY),
      endedAt: null,
      metadata: {},
      ...over,
    }) as NodeBillableIntervalEntity;

  const build = (
    rows: NodeBillableIntervalEntity[],
    nodes: Array<{ id: string; hourlyPriceEur: number | null }>,
  ) => {
    const queryBuilder = {
      where: () => queryBuilder,
      andWhere: () => queryBuilder,
      orderBy: () => queryBuilder,
      getMany: async () => rows,
    };
    return new FleetHistoryService(
      { findOne: async () => ({ id: CLUSTER }) } as never,
      { find: async () => nodes } as never,
      { createQueryBuilder: () => queryBuilder } as never,
      { resolveHourlyEur: async () => 0.0056 } as never,
    );
  };

  /*
   * The choice, pinned: an orphan is what billing charged for, so dropping it
   * would draw a fleet smaller than the bill describes.
   */
  it('counts an interval whose node row no longer exists', async () => {
    const service = build([row({ nodeId: 'gone' })], []);
    const history = await service.getHistory(CLUSTER, { days: 2 });

    expect(history.points[history.points.length - 1].nodes).toBe(1);
    expect(history.orphanedIntervals).toBe(1);
  });

  it('says how many it counted rather than counting them quietly', async () => {
    const service = build(
      [
        row({ id: 'i-1', nodeId: 'gone', endedAt: new Date(Date.now() - DAY) }),
        row({ id: 'i-2', nodeId: 'n-1' }),
      ],
      [{ id: 'n-1', hourlyPriceEur: 0.0056 }],
    );
    const history = await service.getHistory(CLUSTER, { days: 2 });

    expect(history.orphanedIntervals).toBe(1);
    expect(history.orphanedOpenIntervals).toBe(0);
    expect(history.message).toContain('no longer exists');
  });

  /*
   * The one case where counting can overstate the present: an open interval
   * with no node row is the cascade F1 diagnosed, not a running machine.
   */
  it('separates the orphans that are still open', async () => {
    const service = build([row({ nodeId: 'gone', endedAt: null })], []);
    const history = await service.getHistory(CLUSTER, { days: 2 });

    expect(history.orphanedOpenIntervals).toBe(1);
    expect(history.message).toContain('still open');
  });

  it('says nothing when every interval has its node', async () => {
    const service = build(
      [row({ nodeId: 'n-1' })],
      [{ id: 'n-1', hourlyPriceEur: 0.0056 }],
    );
    const history = await service.getHistory(CLUSTER, { days: 2 });

    expect(history.orphanedIntervals).toBe(0);
    expect(history.message).toBeNull();
  });

  it('prefers the price recorded on the node over the catalogue', async () => {
    const service = build(
      [row({ nodeId: 'n-1' })],
      [{ id: 'n-1', hourlyPriceEur: 0.0222 }],
    );
    const history = await service.getHistory(CLUSTER, { days: 2 });

    expect(history.points[history.points.length - 1].hourlyEur).toBe(0.0222);
  });

  it('falls back to the catalogue for an orphan, which has no node to ask', async () => {
    const service = build([row({ nodeId: 'gone' })], []);
    const history = await service.getHistory(CLUSTER, { days: 2 });

    expect(history.points[history.points.length - 1].hourlyEur).toBe(0.0056);
  });

  it('leaves a placeholder shape unpriced instead of asking the catalogue', async () => {
    const service = build(
      [row({ nodeId: 'gone', provider: 'byos', serverType: 'byos' })],
      [],
    );
    const history = await service.getHistory(CLUSTER, { days: 2 });
    const last = history.points[history.points.length - 1];

    expect(last.byShape).toEqual({ [UNKNOWN_SHAPE]: 1 });
    expect(last.unpricedNodes).toBe(1);
    expect(last.hourlyEur).toBe(0);
  });

  it('widens the step rather than returning a sample per hour for a year', async () => {
    const service = build([], []);
    const history = await service.getHistory(CLUSTER, {
      days: 365,
      stepHours: 1,
    });

    expect(history.points.length).toBeLessThanOrEqual(401);
    expect(history.stepSeconds).toBeGreaterThan(3600);
  });
});
