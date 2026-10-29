import {
  ClusterNodeEntity,
  NodeStatus,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';
import { pickRemovable } from './removable.core';

const node = (
  serverName: string,
  region: string,
  hourlyPriceEur: number,
  nodeType = NodeType.WORKER,
): ClusterNodeEntity =>
  ({
    id: serverName,
    serverName,
    region,
    hourlyPriceEur,
    nodeType,
    status: NodeStatus.READY,
  }) as ClusterNodeEntity;

const fleet = [
  node('master', 'fsn1', 0.0096, NodeType.MASTER),
  node('worker-1', 'nbg1', 0.0096),
  node('worker-2', 'hel1', 0.0096),
  node('worker-3', 'fsn1', 0.0088),
  node('worker-4', 'hel1', 0.02),
];

describe('pickRemovable', () => {
  it('gives back the dearest worker', () => {
    expect(pickRemovable(fleet, null)?.name).toBe('worker-4');
  });

  it('spreading, gives back from the region holding the most nodes, the master counted', () => {
    expect(pickRemovable(fleet, null, true)?.name).toBe('worker-4');
    const balanced = fleet.filter((row) => row.serverName !== 'worker-4');
    expect(pickRemovable(balanced, null, true)?.name).toBe('worker-3');
  });

  it('keeps a standing order’s named node over any spreading', () => {
    expect(pickRemovable(fleet, 'worker-1', true)?.name).toBe('worker-1');
  });

  it('never names the master', () => {
    expect(pickRemovable([fleet[0]], null, true)).toBeNull();
  });

  it('never names a node an operator added for high availability', () => {
    const server = {
      ...node('worker-5', 'hel1', 0.05),
      metadata: { haRole: 'server' },
    } as unknown as ClusterNodeEntity;
    const dataHost = {
      ...node('worker-6', 'nbg1', 0.04),
      metadata: { haRole: 'data-host' },
    } as unknown as ClusterNodeEntity;
    expect(pickRemovable([fleet[0], server, dataHost], null)).toBeNull();
    expect(pickRemovable([...fleet, server], null)?.name).toBe('worker-4');
  });
});
