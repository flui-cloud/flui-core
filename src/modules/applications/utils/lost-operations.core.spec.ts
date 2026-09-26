import { LOST_AFTER_MS, lostOperations } from './lost-operations.core';

const now = new Date('2026-09-26T10:00:00Z');
const at = (msAgo: number) => new Date(now.getTime() - msAgo);

describe('lostOperations', () => {
  it('names an operation no job carries once it has been still for the grace', () => {
    const lost = lostOperations(
      [{ id: 'a', createdAt: at(LOST_AFTER_MS + 1) }],
      new Set(),
      now,
    );
    expect(lost.map((o) => o.id)).toEqual(['a']);
  });

  it('leaves one a job still carries, however old', () => {
    expect(
      lostOperations(
        [{ id: 'a', createdAt: at(3_600_000) }],
        new Set(['a']),
        now,
      ),
    ).toEqual([]);
  });

  it('gives a just-created operation time to reach the queue', () => {
    expect(
      lostOperations([{ id: 'a', createdAt: at(5_000) }], new Set(), now),
    ).toEqual([]);
  });

  it('counts the grace from the last progress, not from the start', () => {
    const op = { id: 'a', createdAt: at(3_600_000), updatedAt: at(10_000) };
    expect(lostOperations([op], new Set(), now)).toEqual([]);
  });
});
