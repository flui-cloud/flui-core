import { unreadCatalogue } from '../catalogue/catalogue.core';
import { LadderInput, ShapeFact, walkLadder } from './engine.core';
import { FleetRoom, fleetRoom } from './room.core';
import {
  WhatIfAsk,
  WhatIfGroup,
  answerWhatIf,
  largestBuyable,
  placeOnFleet,
} from './what-if.core';

const shape = (over: Partial<ShapeFact> & { shape: string }): ShapeFact => ({
  cores: 4,
  memoryMi: 8192,
  deprecated: false,
  supportsHourlyBilling: true,
  prices: [{ region: 'fsn1', hourlyEur: 0.0136, monthlyEur: 8.49 }],
  availability: [{ region: 'fsn1', up: true }],
  ...over,
});

const CX33 = shape({ shape: 'cx33' });
const CX23 = shape({
  shape: 'cx23',
  cores: 2,
  memoryMi: 4096,
  prices: [{ region: 'fsn1', hourlyEur: 0.0072, monthlyEur: 4.99 }],
});

const room = (freeMi: number, takesWork = true): FleetRoom =>
  fleetRoom(
    [
      {
        name: 'master',
        role: 'master',
        takesWork,
        allocatable: { cpuMillicores: 4000, memoryMi: 6200 },
        requested: {
          cpuMillicores: 1000,
          memoryMi: 6200 - 512 - freeMi,
        },
        limits: { cpuMillicores: 2000, memoryMi: 6200 },
        used: null,
        apps: [],
      },
    ],
    { cpuMillicores: 200, memoryMi: 512 },
  );

const ladderInput = (
  ask: WhatIfAsk,
  over: Partial<LadderInput['group']> = {},
  shapes: ShapeFact[] = [CX33, CX23],
): LadderInput => ({
  group: {
    provider: 'hetzner',
    regions: ['fsn1'],
    shapes: ['cx33', 'cx23'],
    strategy: 'closest',
    hourlyBillingOnly: false,
    maxMonthlyCost: 30,
    requirement: null,
    capability: { canProvision: true, hasCatalogue: true, billing: 'hourly' },
    ...over,
  },
  clusterRegion: 'fsn1',
  reachableRegions: null,
  ceiling: 3,
  fleet: {
    nodes: 1,
    shapes: ['cx33'],
    committedMonthlyEur: 8.49,
    unpricedNodes: 0,
  },
  demand: {
    name: 'this app',
    cpuMillicores: ask.cpuMillicores,
    memoryMi: ask.memoryMi,
  },
  shapes: { shapes, read: true },
  catalogue: unreadCatalogue('hetzner', 'no-market'),
});

const group = (
  ask: WhatIfAsk,
  provision: 'automatic' | 'manual',
  over: Partial<LadderInput['group']> = {},
  shapes?: ShapeFact[],
): WhatIfGroup => {
  const input = ladderInput(ask, over, shapes);
  return { id: 'g1', provision, input, ladder: walkLadder(input) };
};

describe('what if an app asked for this much', () => {
  const small: WhatIfAsk = { cpuMillicores: 100, memoryMi: 256, replicas: 1 };
  const big: WhatIfAsk = { cpuMillicores: 500, memoryMi: 3000, replicas: 1 };

  it('fits on a node already there and buys nothing', () => {
    const answer = answerWhatIf(small, room(1000), [group(small, 'automatic')]);
    expect(answer.verdict).toBe('fits');
    expect(answer.node).toBe('master');
    expect(answer.sentence).toBe('Fits on master: nothing is bought.');
  });

  it('counts every replica, not just one', () => {
    const three = { ...small, memoryMi: 400, replicas: 3 };
    expect(placeOnFleet(three, room(1000))).toBeNull();
    expect(placeOnFleet({ ...three, replicas: 2 }, room(1000))).toBe('master');
  });

  it('names the machine an automatic group would buy, at its monthly list price', () => {
    const answer = answerWhatIf(big, room(1000), [group(big, 'automatic')]);
    expect(answer).toMatchObject({
      verdict: 'buys',
      shape: 'cx33',
      region: 'fsn1',
      monthlyEur: 8.49,
    });
    expect(answer.sentence).toContain(
      'Flui would buy a cx33 in fsn1 (€8.49 a month)',
    );
  });

  it('says a manual group proposes and buys nothing', () => {
    const answer = answerWhatIf(big, room(1000), [group(big, 'manual')]);
    expect(answer.verdict).toBe('proposes');
    expect(answer.sentence).toContain('The group is manual');
  });

  it('tells sold out apart from too big', () => {
    const soldOut = [
      shape({ shape: 'cx33', availability: [{ region: 'fsn1', up: false }] }),
      CX23,
    ];
    const roomy = { ...big, memoryMi: 3700 };
    const waiting = answerWhatIf(roomy, room(1000), [
      group(roomy, 'automatic', {}, soldOut),
    ]);
    expect(waiting.verdict).toBe('nothing-hosts');
    expect(waiting.sentence).toContain('can be had right now');
    expect(waiting.why).toContain('cx33 is sold out in fsn1');

    const huge = { cpuMillicores: 500, memoryMi: 12000, replicas: 1 };
    const tooBig = answerWhatIf(huge, room(1000), [group(huge, 'automatic')]);
    expect(tooBig.verdict).toBe('nothing-hosts');
    expect(tooBig.sentence).toContain(
      'bigger than any machine the group may buy',
    );
  });

  it('waits for room where the cluster has no group', () => {
    const answer = answerWhatIf(big, room(1000), []);
    expect(answer.verdict).toBe('nothing-hosts');
    expect(answer.sentence).toContain('no scaling group');
  });

  it('is unknown when the cluster could not be asked', () => {
    expect(answerWhatIf(small, null, []).verdict).toBe('unknown');
  });

  it('reports the largest machine the group may buy inside its ceiling', () => {
    const ask = big;
    expect(largestBuyable(ladderInput(ask))).toEqual({
      shape: 'cx33',
      cpuMillicores: 3800,
      memoryMi: 7680,
    });
    expect(largestBuyable(ladderInput(ask, { maxMonthlyCost: 14 }))).toEqual({
      shape: 'cx23',
      cpuMillicores: 1800,
      memoryMi: 3584,
    });
  });
});
