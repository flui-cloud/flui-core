import { groupChanges, snapshotOf } from './group-changes.core';

const base = snapshotOf({
  name: 'default',
  minNodes: 1,
  desiredNodes: 1,
  maxNodes: 3,
  regions: ['fsn1', 'nbg1'],
  shapes: ['cx33', 'cpx32'],
  strategy: 'cheapest',
  settleSeconds: 30,
  hourlyBillingOnly: false,
  maxMonthlyCost: 50,
  provision: 'automatic',
  standingOrders: [],
  requirement: null,
} as never);

describe('groupChanges', () => {
  it('says nothing when nothing changed, whatever the order of a list', () => {
    expect(groupChanges(base, { ...base, regions: ['nbg1', 'fsn1'] })).toEqual(
      [],
    );
  });

  it('names each setting that decides what may be bought, with before and after', () => {
    expect(
      groupChanges(base, {
        ...base,
        shapes: ['cx33'],
        maxMonthlyCost: 30,
        provision: 'manual',
      }),
    ).toEqual([
      'machines cx33, cpx32 → cx33',
      'spend ceiling €50 → €30',
      'mode automatic → manual',
    ]);
  });

  it('says when a ceiling is removed', () => {
    expect(groupChanges(base, { ...base, maxMonthlyCost: null })).toEqual([
      'spend ceiling €50 → none',
    ]);
  });
});
