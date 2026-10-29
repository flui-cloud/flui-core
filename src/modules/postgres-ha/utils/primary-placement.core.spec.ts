import { primaryPlacement } from './primary-placement.core';

const zoneOf = new Map([
  ['s-fsn', 'fsn1'],
  ['s-nbg', 'nbg1'],
  ['s-hel', 'hel1'],
]);
const pods = [
  { name: 'db-ha-1', node: 's-hel', ready: true },
  { name: 'db-ha-2', node: 's-nbg', ready: true },
  { name: 'db-ha-3', node: 's-fsn', ready: true },
];
const base = {
  primary: 'db-ha-1',
  phase: 'Cluster in healthy state',
  instances: 3,
  readyInstances: 3,
  pods,
  zoneOf,
  preferredZones: ['fsn1', 'nbg1'],
  now: Date.parse('2026-10-29T10:00:00Z'),
};

describe('where the primary of a highly available Postgres belongs', () => {
  it('switches a primary that landed in the voting location over to a copy in a location for data', () => {
    expect(primaryPlacement(base)).toEqual({ move: true, target: 'db-ha-2' });
  });

  it('leaves a primary already in a location for data', () => {
    expect(primaryPlacement({ ...base, primary: 'db-ha-3' })).toMatchObject({
      move: false,
    });
  });

  it('never switches over while the cluster is failing over or an instance is missing', () => {
    expect(primaryPlacement({ ...base, phase: 'Failing over' }).move).toBe(
      false,
    );
    expect(primaryPlacement({ ...base, readyInstances: 2 }).move).toBe(false);
  });

  it('waits half an hour after the last move', () => {
    expect(
      primaryPlacement({ ...base, lastMovedAt: '2026-10-29T09:45:00Z' }).move,
    ).toBe(false);
    expect(
      primaryPlacement({ ...base, lastMovedAt: '2026-10-29T09:00:00Z' }).move,
    ).toBe(true);
  });

  it('needs a ready copy in a location for data', () => {
    expect(
      primaryPlacement({
        ...base,
        pods: [
          pods[0],
          { ...pods[1], ready: false },
          { ...pods[2], ready: false },
        ],
      }),
    ).toMatchObject({
      move: false,
      reason: 'no copy ready in a location for data',
    });
  });
});
