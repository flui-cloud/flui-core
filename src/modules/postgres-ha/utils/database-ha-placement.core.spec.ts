import { databaseHaPlacement } from './database-ha-placement.core';

describe('where a highly available database is and how far behind its copies are', () => {
  it('places the primary and each copy, with the lag Postgres reports', () => {
    const placement = databaseHaPlacement({
      primary: 'db-ha-1',
      pods: [
        { name: 'db-ha-3', node: 'w3', ready: true },
        { name: 'db-ha-1', node: 'master', ready: true },
        { name: 'db-ha-2', node: 'w1', ready: false },
      ],
      zoneOf: new Map([
        ['master', 'fsn1'],
        ['w1', 'nbg1'],
        ['w3', 'hel1'],
      ]),
      replication: 'db-ha-2|quorum|3.2|4.0\ndb-ha-3|quorum||\n',
      now: new Date('2026-10-29T10:00:00Z'),
    });
    expect(placement.primary).toEqual({
      instance: 'db-ha-1',
      node: 'master',
      zone: 'fsn1',
      ready: true,
    });
    expect(placement.copies).toEqual([
      {
        instance: 'db-ha-2',
        node: 'w1',
        zone: 'nbg1',
        ready: false,
        confirms: true,
        flushLagMs: 3.2,
        replayLagMs: 4,
      },
      {
        instance: 'db-ha-3',
        node: 'w3',
        zone: 'hel1',
        ready: true,
        confirms: true,
        flushLagMs: null,
        replayLagMs: null,
      },
    ]);
  });

  it('marks a copy the primary does not stream to as one that cannot confirm', () => {
    const placement = databaseHaPlacement({
      primary: 'db-ha-1',
      pods: [
        { name: 'db-ha-1', node: 'master', ready: true },
        { name: 'db-ha-2', node: 'w1', ready: true },
      ],
      zoneOf: new Map(),
      replication: '',
      now: new Date(),
    });
    expect(placement.copies[0]).toMatchObject({
      zone: null,
      confirms: false,
      flushLagMs: null,
    });
  });
});
