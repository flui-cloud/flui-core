import { BadRequestException } from '@nestjs/common';
import { decisionWhere, parseDecisionFilter } from './decision-filter.core';

describe('decision filter', () => {
  it('reads comma lists and dates, and leaves out what was not asked', () => {
    const filter = parseDecisionFilter({
      outcome: 'added,removed',
      since: '2026-09-25T00:00:00Z',
    });
    expect(filter.outcomes).toEqual(['added', 'removed']);
    expect(filter.forces).toBeUndefined();
    expect(filter.since?.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    const where = decisionWhere(filter);
    expect(Object.keys(where).sort()).toEqual(['at', 'outcome']);
  });

  it('refuses a value it does not know, naming the ones it does', () => {
    expect(() => parseDecisionFilter({ outcome: 'bought' })).toThrow(
      BadRequestException,
    );
    expect(() => parseDecisionFilter({ outcome: 'bought' })).toThrow(
      /added, replaced/,
    );
    expect(() => parseDecisionFilter({ before: 'yesterday' })).toThrow(
      /not a date/,
    );
  });

  it('asks nothing of the rows when nothing is filtered', () => {
    expect(decisionWhere(parseDecisionFilter({}))).toEqual({});
  });
});

describe('the nodes shorthand', () => {
  it('stands for every row that says a machine came or went', () => {
    const { outcomes } = parseDecisionFilter({ outcome: 'nodes' });
    expect(outcomes).toEqual([
      'added',
      'replaced',
      'removed',
      'node-ordered',
      'node-joined',
      'purchase-failed',
      'node-drained',
      'node-removed',
    ]);
  });

  it('mixes with named outcomes without repeating them', () => {
    const { outcomes } = parseDecisionFilter({
      outcome: 'nodes,added,alerted',
    });
    expect(outcomes?.filter((o) => o === 'added')).toHaveLength(1);
    expect(outcomes).toContain('alerted');
  });
});
