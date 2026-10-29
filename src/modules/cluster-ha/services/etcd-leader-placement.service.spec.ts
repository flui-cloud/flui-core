jest.mock('@kubernetes/client-node', () => ({}));

import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ThreeLocationCluster } from './cluster-ha.service';
import {
  ETCDCTL_IMAGE,
  EtcdLeaderPlacementService,
} from './etcd-leader-placement.service';

const IDS = {
  master: '10276657743932975437',
  w1: '9372538179322589801',
  w3: '17855658209131950253',
};

const server = (name: string, zone: string) => ({
  metadata: {
    name,
    labels: {
      'topology.kubernetes.io/zone': zone,
      'node-role.kubernetes.io/control-plane': 'true',
    },
  },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
});

function setup(leader: string, validated = true) {
  const members = `{"members":[{"ID":${IDS.master},"name":"lab-master-1a2b3c4d"},{"ID":${IDS.w1},"name":"lab-worker-1-0f9e8d7c"},{"ID":${IDS.w3},"name":"lab-worker-3-aabbccdd"}]}`;
  const runImageOnNode = jest.fn(
    async (_k: string, _node: string, run: { command: string[] }) => {
      if (run.command.includes('status')) {
        return `[{"Endpoint":"https://127.0.0.1:2379","Status":{"leader":${leader}}}]`;
      }
      if (run.command.includes('list')) return members;
      return 'Leadership transferred';
    },
  );
  const service = new EtcdLeaderPlacementService({
    runImageOnNode,
  } as unknown as KubernetesService);
  const ha = {
    cluster: { name: 'ha-lab' },
    kubeconfig: 'kc',
    nodes: [
      server('lab-master', 'fsn1'),
      server('lab-worker-1', 'nbg1'),
      server('lab-worker-3', 'hel1'),
    ],
    state: { level: 'three-locations' },
    topology: {
      zones: ['fsn1', 'nbg1', 'hel1'],
      dataZones: validated ? ['fsn1', 'nbg1'] : ['fsn1', 'nbg1', 'hel1'],
      validated,
    },
  } as unknown as ThreeLocationCluster;
  return { service, runImageOnNode, ha };
}

describe('EtcdLeaderPlacementService', () => {
  it('asks the leader in the voting location to hand over to a member in a location for data', async () => {
    const { service, runImageOnNode, ha } = setup(IDS.w3);
    await expect(service.check(ha)).resolves.toEqual({
      node: 'lab-master',
      zone: 'fsn1',
      moved: true,
    });
    expect(runImageOnNode).toHaveBeenLastCalledWith(
      'kc',
      'lab-worker-3',
      expect.objectContaining({
        image: ETCDCTL_IMAGE,
        hostNetwork: true,
        command: expect.arrayContaining([
          'move-leader',
          BigInt(IDS.master).toString(16),
        ]),
      }),
    );
  });

  it('only reads when the leader is already in a location for data', async () => {
    const { service, runImageOnNode, ha } = setup(IDS.w1);
    await expect(service.check(ha)).resolves.toEqual({
      node: 'lab-worker-1',
      zone: 'nbg1',
      moved: false,
    });
    expect(runImageOnNode).toHaveBeenCalledTimes(2);
  });

  it('reports the leader but never moves it on a forced region, where every location is one for data', async () => {
    const { service, runImageOnNode, ha } = setup(IDS.w3, false);
    await expect(service.check(ha)).resolves.toMatchObject({
      node: 'lab-worker-3',
      moved: false,
    });
    expect(runImageOnNode).toHaveBeenCalledTimes(2);
  });

  it('waits after a move', async () => {
    const { service, runImageOnNode, ha } = setup(IDS.w3);
    await service.check(ha, new Date().toISOString());
    expect(runImageOnNode).toHaveBeenCalledTimes(2);
  });
});
