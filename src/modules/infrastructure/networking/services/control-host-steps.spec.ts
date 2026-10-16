import { jumpMemberAddresses, nodeEndpointHost } from './control-host-steps';
import { ClusterType } from '../../clusters/entities/cluster.entity';

describe('the jump user forwards to workload members only', () => {
  it('leaves out every control node and anything on the control cluster', () => {
    expect(
      jumpMemberAddresses(
        [
          { id: 'ctl', clusterType: ClusterType.CONTROL },
          { id: 'wl', clusterType: ClusterType.WORKLOAD },
        ],
        [
          { role: 'control', clusterId: 'ctl', managementIp: '10.250.0.1' },
          { role: 'control', clusterId: 'ctl', managementIp: '10.250.0.2' },
          { role: 'member', clusterId: 'ctl', managementIp: '10.250.0.7' },
          { role: 'member', clusterId: 'wl', managementIp: '10.250.0.3' },
        ] as any,
      ),
    ).toEqual(['10.250.0.3']);
  });
});

describe('where members dial a control worker', () => {
  it('is its public address', () => {
    expect(
      nodeEndpointHost({ ipAddress: '2.2.2.2', metadata: {} } as any),
    ).toBe('2.2.2.2');
  });

  it('is the declared host on a machine somebody brought', () => {
    expect(
      nodeEndpointHost({
        ipAddress: '10.0.0.5',
        metadata: { byos: { host: '203.0.113.9' } },
      } as any),
    ).toBe('203.0.113.9');
  });

  it('is nothing when the node has no address', () => {
    expect(nodeEndpointHost({ metadata: {} } as any)).toBeUndefined();
  });
});
