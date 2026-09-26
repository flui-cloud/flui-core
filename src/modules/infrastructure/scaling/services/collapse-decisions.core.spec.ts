import { collapseRepeats } from './collapse-decisions.core';

const row = (at: string, over: Record<string, unknown> = {}): any => ({
  at,
  force: 'urgency',
  outcome: 'alerted',
  why: 'No machine fits.',
  asks: 'Add a machine.',
  shape: null,
  region: null,
  operation: null,
  ...over,
});

describe('collapseRepeats', () => {
  it('makes a run of the same alarm one row, counted, with when it began', () => {
    const out = collapseRepeats([row('14:16'), row('14:15'), row('13:10')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ at: '14:16', repeats: 3, since: '13:10' });
  });

  it('keeps apart decisions that differ, and one that started an operation', () => {
    const out = collapseRepeats([
      row('3'),
      row('2', { operation: { id: 'op' } }),
      row('1', { why: 'Something else.' }),
    ]);
    expect(out.map((r) => (r as { repeats?: number }).repeats)).toEqual([
      1, 1, 1,
    ]);
  });
});
