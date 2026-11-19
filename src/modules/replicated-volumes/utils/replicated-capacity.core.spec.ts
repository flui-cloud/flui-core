import { nodesWithoutCapacity } from './replicated-capacity.core';

const capacity = (
  node: string,
  amount: string,
  storageClassName = 'flui-replicated',
) => ({
  storageClassName,
  capacity: amount,
  nodeTopology: { matchLabels: { 'kubernetes.io/hostname': node } },
});

describe('the room the storage engine has published', () => {
  it('names the nodes for copies with no published room yet', () => {
    expect(
      nodesWithoutCapacity(
        [capacity('ha-master', '19448Mi')],
        ['ha-master', 'ha-worker-1'],
      ),
    ).toEqual(['ha-worker-1']);
  });

  it('counts neither an empty capacity, the vote that holds none, nor another class', () => {
    expect(
      nodesWithoutCapacity(
        [
          capacity('ha-master', '0'),
          capacity('ha-worker-1', '19448Mi', 'flui-local'),
          capacity('ha-worker-2', '0'),
        ],
        ['ha-master', 'ha-worker-1'],
      ),
    ).toEqual(['ha-master', 'ha-worker-1']);
  });

  it('is satisfied once every node for copies has room, the way it looked live', () => {
    expect(
      nodesWithoutCapacity(
        [
          capacity('ha-repro-worker-2', '0'),
          capacity('ha-repro-master', '19448Mi'),
          capacity('ha-repro-worker-1', '19448Mi'),
        ],
        ['ha-repro-master', 'ha-repro-worker-1'],
      ),
    ).toEqual([]);
  });
});
