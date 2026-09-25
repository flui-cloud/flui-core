import { fleetRoom } from './room.core';

const reserve = { cpuMillicores: 200, memoryMi: 512 };
const node = (
  name: string,
  alloc: [number, number],
  used: [number, number],
  takesWork = true,
) => ({
  name,
  role: 'worker' as const,
  takesWork,
  allocatable: { cpuMillicores: alloc[0], memoryMi: alloc[1] },
  requested: { cpuMillicores: used[0], memoryMi: used[1] },
});

describe('how much room the fleet has left', () => {
  it('counts what apps reserve, and sets the system reserve aside', () => {
    const room = fleetRoom(
      [node('master', [4000, 7750], [1370, 1946])],
      reserve,
    );

    expect(room.nodes[0].free).toEqual({ cpuMillicores: 2430, memoryMi: 5292 });
    expect(room.largestFit).toEqual({
      cpuMillicores: 2430,
      memoryMi: 5292,
      node: 'master',
    });
  });

  it('names the node with the most memory free as the largest app that still fits', () => {
    const room = fleetRoom(
      [
        node('a', [4000, 8000], [3000, 7000]),
        node('b', [2000, 4000], [100, 500]),
      ],
      reserve,
    );

    expect(room.largestFit?.node).toBe('b');
    expect(room.largestFit?.memoryMi).toBe(2988);
  });

  it('leaves out a node that takes no new work', () => {
    const room = fleetRoom(
      [node('drained', [4000, 8000], [0, 0], false)],
      reserve,
    );

    expect(room.largestFit).toBeNull();
    expect(room.nodes).toHaveLength(1);
  });

  it('never reports negative room on a node reserved past its capacity', () => {
    const room = fleetRoom([node('full', [2000, 4000], [2500, 5000])], reserve);

    expect(room.nodes[0].free).toEqual({ cpuMillicores: 0, memoryMi: 0 });
  });
});
