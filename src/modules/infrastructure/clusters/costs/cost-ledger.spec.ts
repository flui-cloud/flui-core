import {
  NodeRate,
  accrueNode,
  calendarMonth,
  monthsBack,
} from './cost-accrual';
import { LedgerProvider, RatedLifetime, buildLedger } from './cost-ledger';
import { PROVIDER_BILLING } from './provider-billing';

const NOW = new Date('2026-09-26T14:00:00Z');

const cx22: NodeRate = {
  hourlyNet: 0.0104,
  hourlyGross: 0.0124,
  monthlyNet: 6.49,
  monthlyGross: 7.72,
  basis: 'recorded',
};

const hetzner: LedgerProvider = {
  billing: PROVIDER_BILLING.hetzner!,
  vatIncluded: true,
  vatRatePercent: '19',
};
const scaleway: LedgerProvider = {
  billing: PROVIDER_BILLING.scaleway!,
  vatIncluded: false,
  vatRatePercent: null,
};
const ovh: LedgerProvider = {
  billing: PROVIDER_BILLING.ovh!,
  vatIncluded: false,
  vatRatePercent: null,
};

function node(overrides: Partial<RatedLifetime>): RatedLifetime {
  return {
    kind: 'node',
    provider: 'hetzner',
    clusterId: 'c1',
    startedAt: new Date('2026-08-01T00:00:00Z'),
    endedAt: null,
    nodeRate: cx22,
    basis: 'recorded',
    ...overrides,
  };
}

describe('what a node costs in a month', () => {
  const month = calendarMonth(NOW);

  it('forecasts the month to its end instead of repeating what was spent', () => {
    const accrual = accrueNode(
      { startedAt: new Date('2026-08-01T00:00:00Z'), endedAt: null },
      { ...cx22, monthlyNet: 100, monthlyGross: 119 },
      month,
      NOW,
      true,
    );
    expect(accrual.spentHours).toBe(25 * 24 + 14);
    expect(accrual.forecastHours).toBe(30 * 24);
    expect(accrual.forecast.net).toBeGreaterThan(accrual.spent.net);
  });

  it('never charges more than the monthly price where the provider caps', () => {
    const accrual = accrueNode(
      { startedAt: new Date('2026-08-01T00:00:00Z'), endedAt: null },
      cx22,
      month,
      NOW,
      true,
    );
    expect(accrual.forecast.net).toBe(6.49);
    expect(accrual.forecast.gross).toBe(7.72);
  });

  it('keeps counting hours where the provider has no cap', () => {
    const accrual = accrueNode(
      { startedAt: new Date('2026-08-01T00:00:00Z'), endedAt: null },
      cx22,
      month,
      NOW,
      false,
    );
    expect(accrual.forecast.net).toBeCloseTo(720 * 0.0104, 6);
  });

  it('bills a machine that was removed only for the hours it lived', () => {
    const accrual = accrueNode(
      {
        startedAt: new Date('2026-09-10T10:30:00Z'),
        endedAt: new Date('2026-09-10T12:00:00Z'),
      },
      cx22,
      month,
      NOW,
      true,
    );
    expect(accrual.spentHours).toBe(2);
    expect(accrual.forecast).toEqual(accrual.spent);
  });
});

describe('the cost ledger', () => {
  const months = monthsBack(NOW, 2);

  it('gives the current month a forecast and the past ones none', () => {
    const ledger = buildLedger(
      [node({})],
      new Map([['c1', { name: 'control', region: 'fsn1', removed: false }]]),
      new Map([['hetzner', hetzner]]),
      months,
      NOW,
    );
    const [august, september] = ledger.providers[0].months;
    expect(august).toMatchObject({
      month: '2026-08',
      current: false,
      forecastNet: null,
    });
    expect(august.spentNet).toBe(6.49);
    expect(september.current).toBe(true);
    expect(september.forecastNet).toBe(6.49);
    expect(september.spentGross).not.toBeNull();
    expect(ledger.providers[0]).toMatchObject({
      vatIncluded: true,
      vatRatePercent: '19',
    });
  });

  it('keeps a deleted cluster in the bill under its own name', () => {
    const ledger = buildLedger(
      [
        node({
          clusterId: 'gone',
          startedAt: new Date('2026-09-01T00:00:00Z'),
          endedAt: new Date('2026-09-03T00:00:00Z'),
        }),
      ],
      new Map([['gone', { name: 'wc-1', region: 'nbg1', removed: true }]]),
      new Map([['hetzner', hetzner]]),
      months,
      NOW,
    );
    const cluster = ledger.providers[0].clusters[0];
    expect(cluster).toMatchObject({ clusterName: 'wc-1', removed: true });
    expect(cluster.months[1].spentNet).toBeCloseTo(48 * 0.0104, 2);
  });

  it('names a cluster it has no record of as removed rather than dropping it', () => {
    const ledger = buildLedger(
      [node({ clusterId: 'abcdef12-0000' })],
      new Map(),
      new Map([['hetzner', hetzner]]),
      months,
      NOW,
    );
    expect(ledger.providers[0].clusters[0]).toMatchObject({
      clusterName: 'Removed cluster abcdef12',
      removed: true,
    });
  });

  it('counts a machine without a price as unpriced, never as free', () => {
    const ledger = buildLedger(
      [node({ nodeRate: null, basis: null })],
      new Map(),
      new Map([['hetzner', hetzner]]),
      months,
      NOW,
    );
    expect(ledger.providers[0].unpriced).toBe(1);
    expect(ledger.providers[0].months[1].spentNet).toBe(0);
  });

  it('says VAT-inclusive totals only when every provider states its VAT', () => {
    const ledger = buildLedger(
      [
        node({}),
        node({
          provider: 'scaleway',
          clusterId: 'c2',
          nodeRate: { ...cx22, hourlyGross: null, monthlyGross: null },
        }),
      ],
      new Map(),
      new Map([
        ['hetzner', hetzner],
        ['scaleway', scaleway],
      ]),
      months,
      NOW,
    );
    const sw = ledger.providers.find((p) => p.provider === 'scaleway')!;
    expect(sw.vatIncluded).toBe(false);
    expect(sw.months[1].spentGross).toBeNull();
    expect(ledger.totals[1].spentGross).toBeNull();
    expect(ledger.totals[1].spentNet).toBeCloseTo(
      ledger.providers.reduce((sum, p) => sum + p.months[1].spentNet, 0),
      1,
    );
  });

  it('counts a provider it cannot price without adding it to the totals', () => {
    const ledger = buildLedger(
      [node({ provider: 'byos', nodeRate: null, basis: null })],
      new Map(),
      new Map([
        ['byos', { billing: null, vatIncluded: false, vatRatePercent: null }],
      ]),
      months,
      NOW,
    );
    expect(ledger.providers[0]).toMatchObject({ priced: false, unpriced: 1 });
    expect(ledger.providers[0].note).toMatch(/no price list/);
    expect(ledger.totals[1].spentNet).toBe(0);
  });

  it('follows OVH hours past its monthly price', () => {
    const ledger = buildLedger(
      [
        node({
          provider: 'ovh',
          nodeRate: { ...cx22, hourlyGross: null, monthlyGross: null },
        }),
      ],
      new Map(),
      new Map([['ovh', ovh]]),
      months,
      NOW,
    );
    expect(ledger.providers[0].months[1].forecastNet).toBeCloseTo(
      720 * 0.0104,
      2,
    );
  });

  it('knows when its record starts', () => {
    const ledger = buildLedger([], new Map(), new Map(), months, NOW);
    expect(ledger.recordedSince).toBeNull();
    expect(ledger.providers).toEqual([]);
    expect(ledger.totals.map((m) => m.spentNet)).toEqual([0, 0]);
  });
});
