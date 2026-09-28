import { costLines, formatMoney, monthLabel } from './costs-view';

const month = (
  key: string,
  current: boolean,
  spent: number,
  forecast: number | null,
  gross: number | null = null,
) => ({
  month: key,
  current,
  spentNet: spent,
  spentGross: gross,
  forecastNet: current ? forecast : null,
  forecastGross: current && gross !== null ? (forecast ?? 0) * 1.19 : null,
});

const COSTS = {
  currency: 'EUR',
  months: ['2026-08', '2026-09'],
  totals: [
    month('2026-08', false, 20, null),
    month('2026-09', true, 11.2449, 12.3051),
  ],
  recordedSince: new Date('2026-05-12T08:00:00Z'),
  notes: ['Traffic above what each machine includes is not counted.'],
  calculatedAt: new Date('2026-09-26T14:00:00Z'),
  providers: [
    {
      provider: 'hetzner',
      priced: true,
      billedAs:
        'Billed by the hour, never more than the monthly price in one month',
      vatIncluded: true,
      vatRatePercent: '19',
      months: [
        month('2026-08', false, 20, null, 23.8),
        month('2026-09', true, 11.24, 12.31, 13.38),
      ],
      clusters: [
        {
          clusterId: 'c1',
          clusterName: 'control',
          region: 'fsn1',
          removed: false,
          months: [
            month('2026-08', false, 20, null),
            month('2026-09', true, 10.94, 12.01),
          ],
          unpriced: 0,
          listPriced: 1,
        },
        {
          clusterId: 'c2',
          clusterName: 'wc-1',
          region: 'nbg1',
          removed: true,
          months: [
            month('2026-08', false, 0, null),
            month('2026-09', true, 0.3, 0.3),
          ],
          unpriced: 0,
          listPriced: 0,
        },
      ],
      unpriced: 0,
      listPriced: 1,
      note: null,
    },
    {
      provider: 'byos',
      priced: false,
      billedAs: null,
      vatIncluded: false,
      vatRatePercent: null,
      months: [],
      clusters: [],
      unpriced: 2,
      listPriced: 0,
      note: 'Flui has no price list for this provider: the machines are counted, not priced. You pay it directly.',
    },
  ],
};

describe('flui costs', () => {
  it('writes every amount with two decimals and the currency', () => {
    expect(formatMoney(11.2449)).toBe('€11.24');
    expect(formatMoney(3)).toBe('€3.00');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(4.5, 'USD')).toBe('4.50 USD');
    expect(monthLabel('2026-09')).toBe('Sep 2026');
  });

  it('shows spent and forecast apart, with VAT only where the provider states it', () => {
    const text = costLines(COSTS as never).join('\n');
    expect(text).toMatch(
      /Sep 2026 +€11.24 so far · forecast €12.31  \(incl. VAT €14.65\)/,
    );
    expect(text).toContain('VAT 19% on this account');
    expect(text).toContain('wc-1 (deleted)');
    expect(text).toContain("priced at today's list price");
    expect(text).toContain('no price list for this provider');
    expect(text).not.toMatch(/\d\.\d{3,}/);
  });

  it('says there is nothing yet instead of printing an empty table', () => {
    expect(costLines({ ...COSTS, providers: [] } as never)).toEqual([
      'No machine has been recorded yet: costs start with the first cluster Flui creates.',
    ]);
  });

  it('narrows to one provider on request', () => {
    const text = costLines(COSTS as never, 'byos').join('\n');
    expect(text).not.toContain('All providers');
    expect(text).not.toContain('hetzner');
    expect(costLines(COSTS as never, 'ovh')).toEqual([
      'Nothing recorded on ovh in these months.',
    ]);
  });
});
