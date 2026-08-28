import { CatalogueReading, unreadCatalogue } from '../catalogue/catalogue.core';
import {
  LadderCapability,
  LadderInput,
  ShapeFact,
  evaluateShape,
  fleetOf,
  preferredShape,
  reasonsOf,
  requirementLine,
  walkLadder,
} from './engine.core';

const HETZNER: LadderCapability = {
  canProvision: true,
  hasCatalogue: true,
  billing: 'hourly',
};
const CONTABO: LadderCapability = {
  canProvision: false,
  hasCatalogue: true,
  billing: 'monthly',
};
const BYOS: LadderCapability = {
  canProvision: false,
  hasCatalogue: false,
  billing: 'none',
};

const shape = (over: Partial<ShapeFact> & { shape: string }): ShapeFact => ({
  cores: 4,
  memoryMi: 8192,
  deprecated: false,
  supportsHourlyBilling: true,
  prices: [{ region: 'fsn1', hourlyEur: 0.0074, monthlyEur: 5.4 }],
  ...over,
});

const CX32 = shape({ shape: 'cx32' });
const CX22 = shape({
  shape: 'cx22',
  cores: 2,
  memoryMi: 4096,
  prices: [{ region: 'fsn1', hourlyEur: 0.004, monthlyEur: 3.2 }],
});
const CPX41 = shape({
  shape: 'cpx41',
  cores: 8,
  memoryMi: 16384,
  prices: [
    { region: 'fsn1', hourlyEur: 0.03, monthlyEur: 20 },
    { region: 'hel1', hourlyEur: 0.028, monthlyEur: 19 },
  ],
});

const input = (over: Partial<LadderInput> = {}): LadderInput => ({
  group: {
    provider: 'hetzner',
    regions: ['fsn1', 'hel1'],
    shapes: ['cx32', 'cpx41'],
    strategy: 'closest',
    hourlyBillingOnly: false,
    maxMonthlyCost: null,
    requirement: null,
    capability: HETZNER,
    ...(over.group ?? {}),
  },
  clusterRegion: 'fsn1',
  ceiling: 5,
  fleet: {
    nodes: 2,
    shapes: ['cx32', 'cx32'],
    committedMonthlyEur: 10.8,
    unpricedNodes: 0,
  },
  demand: { name: 'flui-apps/checkout', cpuMillicores: 500, memoryMi: 4096 },
  shapes: { shapes: [CX32, CX22, CPX41], read: true },
  catalogue: unreadCatalogue('hetzner', 'unreachable'),
  ...over,
});

const reading = (
  shapes: CatalogueReading['shapes'],
  ageSeconds: number | null = 12,
): CatalogueReading => ({
  provider: 'hetzner',
  state: 'read',
  shapes,
  ageSeconds,
  stale: false,
});

describe('the urgency ladder', () => {
  it('stops at the first rung that would work', () => {
    const result = walkLadder(input());

    expect(result.chosen).toMatchObject({
      step: 1,
      shape: 'cx32',
      region: 'fsn1',
      outcome: 'would-buy',
    });
    expect(result.rungs).toHaveLength(1);
    expect(result.asks).toBeNull();
  });

  it('falls to another region when the preferred shape is down at home', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'hetzner',
          regions: ['fsn1', 'hel1'],
          shapes: ['cpx41'],
          strategy: 'closest',
          hourlyBillingOnly: false,
          maxMonthlyCost: null,
          requirement: null,
          capability: HETZNER,
        },
        catalogue: reading([
          {
            shape: 'cpx41',
            state: 'sold-out',
            everywhere: false,
            upIn: ['hel1'],
            downIn: ['fsn1'],
          },
        ]),
      }),
    );

    expect(result.rungs[0]).toMatchObject({
      outcome: 'unavailable',
      region: 'fsn1',
    });
    expect(result.rungs[0].note).toContain('read 12s ago');
    expect(result.chosen).toMatchObject({ step: 2, region: 'hel1' });
  });

  it('walks past a shape that cannot hold the pending request', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'hetzner',
          regions: ['fsn1'],
          shapes: ['cx22', 'cx32'],
          strategy: 'cheapest',
          hourlyBillingOnly: false,
          maxMonthlyCost: null,
          requirement: null,
          capability: HETZNER,
        },
        demand: {
          name: 'flui-apps/checkout',
          cpuMillicores: 500,
          memoryMi: 4096,
        },
      }),
    );

    // Cheapest never promotes a shape that does not fit: fitting is the filter,
    // not a preference.
    expect(result.rungs[0]).toMatchObject({
      shape: 'cx22',
      outcome: 'does-not-fit',
    });
    expect(result.rungs[0].note).toContain('3584Mi');
    expect(result.chosen).toMatchObject({ step: 3, shape: 'cx32' });
  });

  it('declines a shape that would take the fleet past its monthly ceiling', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'hetzner',
          regions: ['fsn1'],
          shapes: ['cpx41'],
          strategy: 'cheapest',
          hourlyBillingOnly: false,
          maxMonthlyCost: 25,
          requirement: null,
          capability: HETZNER,
        },
      }),
    );

    expect(result.rungs[0]).toMatchObject({ outcome: 'over-budget' });
    expect(result.rungs[0].note).toContain('ceiling of €25');
    expect(result.chosen).toBeNull();
  });

  it('refuses everything by limit, not by outage, when the provider bills monthly', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'contabo',
          regions: ['eu'],
          shapes: ['vps-m'],
          strategy: 'cheapest',
          hourlyBillingOnly: true,
          maxMonthlyCost: null,
          requirement: null,
          capability: CONTABO,
        },
        clusterRegion: 'eu',
        shapes: { shapes: [], read: false },
        catalogue: unreadCatalogue('contabo', 'not-covered'),
      }),
    );

    expect(result.rungs[0]).toMatchObject({ outcome: 'refused-by-limit' });
    expect(result.rungs[0].note).toContain('hourly billing only');
    expect(result.chosen).toBeNull();
  });

  it('refuses a monthly-commitment shape by limit even where the provider bills hourly', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'hetzner',
          regions: ['fsn1'],
          shapes: ['ccx13'],
          strategy: 'cheapest',
          hourlyBillingOnly: true,
          maxMonthlyCost: null,
          requirement: null,
          capability: HETZNER,
        },
        shapes: {
          shapes: [shape({ shape: 'ccx13', supportsHourlyBilling: false })],
          read: true,
        },
      }),
    );

    expect(result.rungs[0]).toMatchObject({
      shape: 'ccx13',
      outcome: 'refused-by-limit',
    });
    expect(result.rungs[0].note).toContain('monthly commitment');
  });

  it('refuses by limit once the fleet stands at the ceiling of the force', () => {
    const result = walkLadder(
      input({
        ceiling: 2,
        fleet: {
          nodes: 2,
          shapes: ['cx32', 'cx32'],
          committedMonthlyEur: 10.8,
          unpricedNodes: 0,
        },
      }),
    );

    expect(result.rungs[0]).toMatchObject({ outcome: 'refused-by-limit' });
    expect(result.rungs[0].note).toContain('may not go past 2');
    expect(result.asks).toContain('raise what it may spend');
  });
});

describe('the three capability cases', () => {
  it('would buy where Flui can create a server', () => {
    const result = walkLadder(input());

    expect(result.chosen?.outcome).toBe('would-buy');
    expect(result.asks).toBeNull();
  });

  it('names a shape and a price in the alarm where there is a catalogue and no create API', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'contabo',
          regions: ['fsn1'],
          shapes: ['cx32'],
          strategy: 'cheapest',
          hourlyBillingOnly: false,
          maxMonthlyCost: null,
          requirement: null,
          capability: CONTABO,
        },
      }),
    );

    expect(result.chosen).toBeNull();
    expect(result.rungs[0].outcome).toBe('alert');
    expect(result.asks).toContain('cx32');
    expect(result.asks).toContain('0.0074');
    expect(result.asks).toContain('flui node connect');
    expect(result.asks).toContain('cannot create a server on contabo');
  });

  it('asks for what a machine has to hold where no catalogue publishes a shape', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'byos',
          regions: [],
          shapes: [],
          strategy: 'uniform',
          hourlyBillingOnly: false,
          maxMonthlyCost: null,
          requirement: { cpu: '2', memory: '8Gi' },
          capability: BYOS,
        },
        clusterRegion: 'own',
        demand: null,
        shapes: { shapes: [], read: false },
        catalogue: unreadCatalogue('byos', 'no-market'),
      }),
    );

    expect(result.chosen).toBeNull();
    expect(result.rungs.every((rung) => rung.shape === null)).toBe(true);
    expect(result.rungs[0].note).toContain('publishes no catalogue');
    // A bare number is a count, not a quantity: "2 of CPU" is not English.
    expect(result.asks).toContain('2 CPU and 8Gi of memory');
    expect(result.asks).toContain('flui node connect');
  });

  it('carries the pending request into the alarm where one is waiting on BYOS', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'byos',
          regions: [],
          shapes: [],
          strategy: 'uniform',
          hourlyBillingOnly: false,
          maxMonthlyCost: null,
          requirement: { cpu: '2', memory: '8Gi' },
          capability: BYOS,
        },
        clusterRegion: 'own',
        shapes: { shapes: [], read: false },
        catalogue: unreadCatalogue('byos', 'no-market'),
      }),
    );

    expect(result.asks).toContain('500m of CPU and 4096Mi of memory');
  });

  it('walks one rung, not four identical ones, where no shape can be named at all', () => {
    const result = walkLadder({
      group: {
        provider: 'byos',
        regions: [],
        shapes: [],
        strategy: 'uniform',
        hourlyBillingOnly: false,
        maxMonthlyCost: null,
        requirement: { cpu: '4', memory: '8Gi' },
        capability: {
          canProvision: false,
          hasCatalogue: false,
          billing: 'none',
        },
      },
      clusterRegion: 'byos',
      ceiling: 3,
      fleet: { nodes: 1, shapes: [], committedMonthlyEur: 0, unpricedNodes: 1 },
      demand: null,
      shapes: { shapes: [], read: false },
      catalogue: unreadCatalogue('byos', 'no-market'),
    } as never);

    // One rung that could not name a shape, then the alarm. Four copies of the
    // same sentence read as four things tried.
    expect(result.rungs).toHaveLength(2);
    expect(result.rungs[1].outcome).toBe('alert');
    // And the alarm's own sentence is not folded back into the reasons.
    expect(reasonsOf(result.rungs)).not.toContain('flui node connect');
  });

  it('keeps "of" where the requirement carries a unit, and drops it where it does not', () => {
    const withUnit = requirementLine({
      demand: null,
      group: { requirement: { cpu: '4000m', memory: '8Gi' } },
    } as never);
    const bare = requirementLine({
      demand: null,
      group: { requirement: { cpu: '4', memory: '8Gi' } },
    } as never);

    expect(withUnit).toBe('4000m of CPU and 8Gi of memory');
    expect(bare).toBe('4 CPU and 8Gi of memory');
  });
});

describe('the strategies, among the shapes that already fit', () => {
  const twoRegions = (strategy: 'cheapest' | 'closest' | 'roomiest') =>
    walkLadder(
      input({
        group: {
          provider: 'hetzner',
          regions: ['fsn1', 'hel1'],
          shapes: ['cx32', 'cpx41'],
          strategy,
          hourlyBillingOnly: false,
          maxMonthlyCost: null,
          requirement: null,
          capability: HETZNER,
        },
        // Only the third rung opens the choice to every shape.
        shapes: { shapes: [CX32, CPX41], read: true },
        demand: {
          name: 'flui-apps/checkout',
          cpuMillicores: 500,
          memoryMi: 12288,
        },
      }),
    );

  it('cheapest takes the lowest price among the shapes on the same rung', () => {
    const result = walkLadder(
      input({
        group: {
          provider: 'hetzner',
          regions: ['fsn1'],
          shapes: ['cx32', 'cpx41'],
          strategy: 'cheapest',
          hourlyBillingOnly: false,
          maxMonthlyCost: null,
          requirement: null,
          capability: HETZNER,
        },
        demand: {
          name: 'flui-apps/checkout',
          cpuMillicores: 500,
          memoryMi: 2048,
        },
      }),
    );

    expect(result.chosen).toMatchObject({ shape: 'cx32', region: 'fsn1' });
  });

  it('keeps the cluster’s region ahead of a lower price elsewhere, cheapest or not', () => {
    // The rungs are the urgency order and the strategy chooses inside one: a
    // cheaper region cannot pull a purchase off the rung that already works.
    const result = twoRegions('cheapest');
    expect(result.chosen).toMatchObject({ shape: 'cpx41', region: 'fsn1' });
  });

  it('closest stays in the cluster’s region even when another is cheaper', () => {
    const result = twoRegions('closest');
    expect(result.chosen).toMatchObject({ shape: 'cpx41', region: 'fsn1' });
  });

  it('uniform prefers the shape the fleet already is', () => {
    const uniform = input({
      group: {
        provider: 'hetzner',
        regions: ['fsn1'],
        shapes: ['cx32', 'cpx41'],
        strategy: 'uniform',
        hourlyBillingOnly: false,
        maxMonthlyCost: null,
        requirement: null,
        capability: HETZNER,
      },
      fleet: {
        nodes: 2,
        shapes: ['cpx41', 'cpx41'],
        committedMonthlyEur: 40,
        unpricedNodes: 0,
      },
    });

    expect(preferredShape(uniform)).toBe('cpx41');
    expect(walkLadder(uniform).chosen).toMatchObject({ shape: 'cpx41' });
  });
});

describe('one shape in one region, for a standing order', () => {
  it('says it would buy when the market has it', () => {
    expect(evaluateShape(input(), 'cx32', 'fsn1')).toMatchObject({
      outcome: 'would-buy',
      hourlyEur: 0.0074,
    });
  });

  it('says the catalogue reports it down, and how old that reading is', () => {
    const rung = evaluateShape(
      input({
        catalogue: reading(
          [
            {
              shape: 'cx32',
              state: 'sold-out',
              everywhere: false,
              upIn: [],
              downIn: ['fsn1'],
            },
          ],
          null,
        ),
      }),
      'cx32',
      'fsn1',
    );

    expect(rung.outcome).toBe('unavailable');
    expect(rung.note).toContain('age of that reading unknown');
  });
});

/**
 * The budget check is only sound in one direction: an unpriced node adds
 * nothing to the committed figure, so going over the ceiling is certain and
 * staying under it never was. The rung says which of the two it is.
 */
describe('what the ceiling could and could not prove', () => {
  const capped = (unpricedNodes: number, maxMonthlyCost: number | null) =>
    input({
      group: {
        provider: 'hetzner',
        regions: ['fsn1'],
        shapes: ['cx32'],
        strategy: 'cheapest',
        hourlyBillingOnly: false,
        maxMonthlyCost,
        requirement: null,
        capability: HETZNER,
      },
      fleet: {
        nodes: 2 + unpricedNodes,
        shapes: ['cx32', 'cx32'],
        committedMonthlyEur: 10.8,
        unpricedNodes,
      },
    });

  it('says the committed figure is a floor when part of the fleet has no price', () => {
    const rung = walkLadder(capped(1, 40)).chosen;

    expect(rung).toMatchObject({ outcome: 'would-buy' });
    expect(rung?.note).toContain('1 node(s) carry no price');
    expect(rung?.note).toContain('floor');
  });

  it('says nothing where every node carries a price', () => {
    expect(walkLadder(capped(0, 40)).chosen?.note).toBeUndefined();
  });

  it('says nothing where no ceiling was weighed at all', () => {
    expect(walkLadder(capped(1, null)).chosen?.note).toBeUndefined();
  });

  it('carries it onto a standing order, which meets the same ceiling', () => {
    const rung = evaluateShape(capped(2, 40), 'cx32', 'fsn1');
    expect(rung.note).toContain('2 node(s) carry no price');
  });
});

describe('the fleet a node table describes', () => {
  it('sums the priced nodes and counts the rest', () => {
    const fleet = fleetOf(
      [
        { serverType: 'cx32', hourlyPriceEur: 0.02 },
        { serverType: 'cx32', hourlyPriceEur: null },
        { serverType: null, hourlyPriceEur: 0.01 },
      ],
      { nodes: 9, shape: 'cx22' },
    );

    expect(fleet.nodes).toBe(3);
    expect(fleet.unpricedNodes).toBe(1);
    expect(fleet.committedMonthlyEur).toBeCloseTo(21.9, 5);
    expect(fleet.shapes).toEqual(['cx32', 'cx32']);
  });

  /** A fleet of zero is the one reading that is certainly wrong while a node runs. */
  it('falls back to the cluster’s own count, and prices none of it', () => {
    const fleet = fleetOf([], { nodes: 2, shape: 'cx22' });

    expect(fleet.nodes).toBe(2);
    expect(fleet.unpricedNodes).toBe(2);
    expect(fleet.committedMonthlyEur).toBe(0);
    expect(fleet.shapes).toEqual(['cx22', 'cx22']);
  });

  it('names no shape where the cluster records none', () => {
    expect(fleetOf([], { nodes: 2, shape: null }).shapes).toEqual([]);
  });
});
