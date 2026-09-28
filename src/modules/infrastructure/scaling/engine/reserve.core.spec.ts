import { NODE_RESERVE, ShapeFact } from './engine.core';
import { fleetArchitecture, measuredReserve } from './reserve.core';

describe('the share of a new node the system takes', () => {
  it('adds what the provider sold beyond what the node offers, and what runs on every node', () => {
    const reserve = measuredReserve([
      {
        role: 'master',
        nominal: { cpuMillicores: 4000, memoryMi: 8192 },
        capacity: { cpuMillicores: 4000, memoryMi: 7900 },
        allocatable: { cpuMillicores: 4000, memoryMi: 7800 },
        everyNode: { cpuMillicores: 300, memoryMi: 900 },
      },
      {
        role: 'worker',
        nominal: { cpuMillicores: 2000, memoryMi: 2048 },
        capacity: { cpuMillicores: 2000, memoryMi: 1950 },
        allocatable: { cpuMillicores: 2000, memoryMi: 1850 },
        everyNode: { cpuMillicores: 150, memoryMi: 250 },
      },
    ]);
    expect(reserve).toEqual({
      cpuMillicores: NODE_RESERVE.cpuMillicores + 150,
      memoryMi: NODE_RESERVE.memoryMi + 198 + 250,
    });
  });

  it('measures on the node itself where its machine is unknown', () => {
    const reserve = measuredReserve([
      {
        role: 'master',
        nominal: null,
        capacity: { cpuMillicores: 2000, memoryMi: 4000 },
        allocatable: { cpuMillicores: 2000, memoryMi: 3900 },
        everyNode: { cpuMillicores: 0, memoryMi: 100 },
      },
    ]);
    expect(reserve.memoryMi).toBe(NODE_RESERVE.memoryMi + 200);
  });
});

describe('what the fleet runs on', () => {
  const fact = (shape: string, architecture: 'x86' | 'arm' | null) =>
    ({ shape, architecture }) as ShapeFact;

  it('is the one architecture every known node shares', () => {
    const facts = [fact('a', 'x86'), fact('b', 'arm'), fact('c', null)];
    expect(fleetArchitecture(['a', 'a', 'c'], facts)).toBe('x86');
    expect(fleetArchitecture(['a', 'b'], facts)).toBeNull();
    expect(fleetArchitecture(['c'], facts)).toBeNull();
  });
});
