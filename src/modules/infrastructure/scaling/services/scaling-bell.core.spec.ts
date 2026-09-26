import { scalingBellOf } from './scaling-bell.core';

const row = {
  id: 'd1',
  groupId: 'g1',
  clusterId: 'c1',
  force: 'urgency',
  outcome: 'declined',
  did: 'Nothing was bought.',
  why: 'The group is manual.',
  asks: null,
  pendingPods: 0,
};

describe('scalingBellOf', () => {
  it('rings when a machine joins, linking to Now', () => {
    const bell = scalingBellOf(
      {
        ...row,
        force: 'fleet',
        outcome: 'node-joined',
        did: 'worker-3 joined.',
      },
      null,
      'staging',
    );
    expect(bell).toMatchObject({
      tone: 'success',
      tab: 'now',
      title: 'staging: a machine joined',
      body: 'worker-3 joined.',
    });
  });

  it('offers Try again on a failed purchase', () => {
    const bell = scalingBellOf(
      {
        ...row,
        force: 'fleet',
        outcome: 'purchase-failed',
        why: 'resource_unavailable',
      },
      null,
      'staging',
    );
    expect(bell).toMatchObject({
      tone: 'error',
      retry: true,
      body: 'resource_unavailable',
    });
  });

  it('rings once when an alarm opens, not on every repeat', () => {
    const open = { ...row, outcome: 'alerted', asks: 'Buy a cx33 by hand.' };
    expect(
      scalingBellOf(open, { outcome: 'declined', pendingPods: 1 }, 'staging')
        ?.body,
    ).toBe('Buy a cx33 by hand.');
    expect(
      scalingBellOf(open, { outcome: 'alerted', pendingPods: 1 }, 'staging'),
    ).toBeNull();
  });

  it('rings when the alarm closes', () => {
    expect(
      scalingBellOf(row, { outcome: 'alerted', pendingPods: 1 }, 'staging')
        ?.title,
    ).toBe('staging: the scaling alarm closed');
  });

  it('rings when an app starts waiting for room, and stays quiet while it keeps waiting', () => {
    const waiting = { ...row, pendingPods: 2 };
    expect(
      scalingBellOf(waiting, { outcome: 'declined', pendingPods: 0 }, 'staging')
        ?.title,
    ).toBe('staging: an app is waiting for room');
    expect(
      scalingBellOf(
        waiting,
        { outcome: 'declined', pendingPods: 2 },
        'staging',
      ),
    ).toBeNull();
  });

  it('keeps a standing answer and the drain step out of the bell', () => {
    expect(
      scalingBellOf(row, { outcome: 'declined', pendingPods: 0 }, 'staging'),
    ).toBeNull();
    expect(
      scalingBellOf(
        { ...row, force: 'fleet', outcome: 'node-drained' },
        null,
        'staging',
      ),
    ).toBeNull();
    expect(
      scalingBellOf(
        { ...row, force: 'person', outcome: 'changed' },
        null,
        'staging',
      ),
    ).toBeNull();
  });
});
