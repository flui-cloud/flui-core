import { CostInput, scalingCost } from './cost-scenarios.core';
import { ShapeFact } from './engine/engine.core';

function fact(
  shape: string,
  hourlyEur: number | null,
  monthlyEur: number | null,
  region = 'fr-par-1',
): ShapeFact {
  return {
    shape,
    cores: 2,
    memoryMi: 4096,
    deprecated: false,
    supportsHourlyBilling: true,
    architecture: 'x86',
    availability: null,
    prices: [{ region, hourlyEur, monthlyEur }],
  };
}

function input(overrides: Partial<CostInput> = {}): CostInput {
  return {
    provider: 'scaleway',
    hasCatalogue: true,
    min: 1,
    max: 5,
    shapes: ['DEV1-M'],
    regions: ['fr-par-1'],
    maxMonthlyCost: null,
    facts: { read: true, shapes: [fact('DEV1-M', 10 / 730, 10)] },
    ...overrides,
  };
}

describe('scalingCost', () => {
  it('reads the four scenarios off the node limits and the provider price', () => {
    const cost = scalingCost(input());
    expect(cost.priced).toBe(true);
    expect(cost.scenarios.map((s) => [s.kind, s.lowEur])).toEqual([
      ['at-min', 10],
      ['short-peak', 10.22],
      ['daily-peak', 16.58],
      ['worst-case', 50],
    ]);
    expect(cost.suggestedCeilingEur).toBe(50);
  });

  it('gives a range when the machines on the list cost different amounts', () => {
    const cost = scalingCost(
      input({
        shapes: ['DEV1-M', 'DEV1-L'],
        facts: {
          read: true,
          shapes: [fact('DEV1-M', 10 / 730, 10), fact('DEV1-L', 20 / 730, 20)],
        },
      }),
    );
    const worst = cost.scenarios.find((s) => s.kind === 'worst-case');
    expect(worst).toMatchObject({ lowEur: 50, highEur: 100 });
    expect(cost.cheapest?.shape).toBe('DEV1-M');
    expect(cost.dearest?.shape).toBe('DEV1-L');
    expect(cost.says).toContain('between');
  });

  it('never invents a price: an unpriced machine is named and left out', () => {
    const cost = scalingCost(
      input({
        shapes: ['DEV1-M', 'MYSTERY'],
        facts: {
          read: true,
          shapes: [fact('DEV1-M', 10 / 730, 10), fact('MYSTERY', null, null)],
        },
      }),
    );
    expect(cost.unpricedShapes).toEqual(['MYSTERY']);
    expect(cost.says).toContain('MYSTERY has no published price');

    const none = scalingCost(
      input({ facts: { read: true, shapes: [fact('DEV1-M', null, null)] } }),
    );
    expect(none.priced).toBe(false);
    expect(none.scenarios).toEqual([]);
    expect(none.says).toContain('publishes no price for DEV1-M');
  });

  it('shows no peak it cannot price by the hour', () => {
    const cost = scalingCost(
      input({ facts: { read: true, shapes: [fact('DEV1-M', null, 10)] } }),
    );
    const short = cost.scenarios.find((s) => s.kind === 'short-peak');
    expect(short?.lowEur).toBeNull();
    expect(cost.scenarios.find((s) => s.kind === 'worst-case')?.lowEur).toBe(
      50,
    );
  });

  it('says when the spending ceiling stops the group before its maximum', () => {
    const cost = scalingCost(input({ maxMonthlyCost: 20 }));
    expect(cost.ceiling).toMatchObject({
      monthlyEur: 20,
      nodesWithin: 2,
      stopsBeforeMax: true,
    });
    expect(cost.ceiling.says).toContain('about 2 nodes');

    const net = scalingCost(input({ maxMonthlyCost: 60 }));
    expect(net.ceiling.stopsBeforeMax).toBe(false);
    expect(net.ceiling.says).toContain('only stops a runaway');
  });

  it('has nothing to price where there is no catalogue or no reading', () => {
    expect(scalingCost(input({ hasCatalogue: false })).priced).toBe(false);
    const unread = scalingCost(input({ facts: { read: false, shapes: [] } }));
    expect(unread.says).toContain('could not be read');
  });

  it('keeps the peaks out when the group cannot grow', () => {
    const cost = scalingCost(input({ min: 2, max: 2 }));
    expect(cost.scenarios.map((s) => s.kind)).toEqual(['at-min', 'worst-case']);
  });
});
