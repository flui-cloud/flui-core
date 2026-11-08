jest.mock('@kubernetes/client-node', () => ({}));
jest.mock(
  '../../infrastructure/clusters/utils/cluster-metadata-merge.util',
  () => ({ mergeClusterMetadata: jest.fn() }),
);

import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { mergeClusterMetadata } from '../../infrastructure/clusters/utils/cluster-metadata-merge.util';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ClusterHaService } from './cluster-ha.service';
import { ClusterHaSweepService } from './cluster-ha-sweep.service';
import { EtcdLeaderPlacementService } from './etcd-leader-placement.service';
import { SiteRoundTripService } from './site-round-trip.service';

const server = (name: string, zone: string, address: string) => ({
  metadata: {
    name,
    labels: {
      'topology.kubernetes.io/zone': zone,
      'node-role.kubernetes.io/control-plane': 'true',
    },
  },
  status: {
    conditions: [{ type: 'Ready', status: 'True' }],
    addresses: [{ type: 'InternalIP', address }],
  },
});

function setup(level: 'three-locations' | 'standard' = 'three-locations') {
  const runImageOnNode = jest.fn(
    async (_k: string, _node: string, run: { command: string[] }) =>
      run.command[2]
        .split('\n')
        .map((line) => /-q (\S+)/.exec(line)![1])
        .map(
          (a) =>
            `${a} round-trip min/avg/max = 1.0/${a.endsWith('.4') ? '35.0' : '3.0'}/4.0 ms`,
        )
        .join('\n'),
  );
  const kubernetes = { runImageOnNode } as unknown as KubernetesService;
  const etcd = {
    check: jest
      .fn()
      .mockResolvedValue({ node: 'w1', zone: 'nbg1', moved: false }),
  } as unknown as EtcdLeaderPlacementService;
  const clusterHa = {
    inspect: jest.fn().mockResolvedValue({
      cluster: { name: 'ha-lab' },
      kubeconfig: 'kc',
      nodes: [
        server('master', 'fsn1', '10.0.0.2'),
        server('w1', 'nbg1', '10.0.0.3'),
        server('w3', 'hel1', '10.0.0.4'),
      ],
      state: { level },
      topology: {
        zones: ['fsn1', 'nbg1', 'hel1'],
        dataZones: ['fsn1', 'nbg1'],
        validated: true,
        measured: true,
      },
    }),
  } as unknown as ClusterHaService;
  const service = new ClusterHaSweepService(
    {} as Repository<ClusterEntity>,
    clusterHa,
    etcd,
    new SiteRoundTripService(kubernetes),
  );
  return { service, etcd };
}

const cluster = { id: 'c1', name: 'ha-lab', metadata: {} } as ClusterEntity;

describe('ClusterHaSweepService', () => {
  beforeEach(() => jest.mocked(mergeClusterMetadata).mockClear());

  it('records the etcd leader and the round trip between each pair of locations', async () => {
    const { service } = setup();
    await service.check(cluster);
    expect(mergeClusterMetadata).toHaveBeenCalledWith(expect.anything(), 'c1', {
      haObserved: {
        at: expect.any(String),
        etcdLeader: { node: 'w1', zone: 'nbg1' },
        roundTrips: [
          { from: 'fsn1', to: 'hel1', ms: 35 },
          { from: 'fsn1', to: 'nbg1', ms: 3 },
          { from: 'hel1', to: 'nbg1', ms: 3 },
        ],
        etcdLeaderMovedAt: undefined,
      },
    });
  });

  it('leaves a cluster that does not span three locations alone', async () => {
    const { service, etcd } = setup('standard');
    await service.check(cluster);
    expect(etcd.check).not.toHaveBeenCalled();
    expect(mergeClusterMetadata).not.toHaveBeenCalled();
  });
});
