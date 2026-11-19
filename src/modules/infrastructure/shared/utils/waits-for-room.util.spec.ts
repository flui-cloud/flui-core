jest.mock('@kubernetes/client-node', () => ({}));

import { waitsForRoom } from './waits-for-room.util';

const unschedulable = (message: string) =>
  ({
    metadata: { name: 'probe' },
    status: {
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message,
        },
      ],
    },
  }) as never;

describe('a pod waiting for a node with room', () => {
  it('is one no node can take for lack of CPU or memory', () => {
    expect(
      waitsForRoom(
        unschedulable('0/3 nodes are available: 3 Insufficient memory.'),
      ),
    ).toBe(true);
  });

  it('is not one whose volume has no published room yet, which a new node would not have either', () => {
    expect(
      waitsForRoom(
        unschedulable(
          '0/3 nodes are available: 3 node(s) did not have enough free storage. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.',
        ),
      ),
    ).toBe(false);
  });

  it('is not one pinned to a machine by its volume', () => {
    expect(
      waitsForRoom(
        unschedulable(
          '0/3 nodes are available: 1 node(s) had volume node affinity conflict.',
        ),
      ),
    ).toBe(false);
  });
});
