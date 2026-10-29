jest.mock('@kubernetes/client-node', () => ({}));

import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { NodeTopologyReconciler } from './node-topology.reconciler';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeType } from '../entities/cluster-node.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { HetznerCapabilitiesService } from '../../../providers/implementations/hetzner/hetzner-capabilities.service';
import { ByosCapabilitiesService } from '../../../providers/implementations/byos/byos-capabilities.service';
import { ICredentialProvider } from '../../../providers/interfaces/credential-provider.interface';

const config = {
  get: (_key: string, fallback?: unknown) => fallback,
} as unknown as ConfigService;

const capabilities = new CapabilitiesProviderFactory([
  {
    provider: CloudProvider.HETZNER,
    service: new HetznerCapabilitiesService(
      config,
      {} as unknown as ICredentialProvider,
    ),
  },
  { provider: CloudProvider.BYOS, service: new ByosCapabilitiesService() },
]);

const node = (
  serverName: string,
  nodeType: NodeType,
  region: string | null,
): ClusterNodeEntity =>
  ({ serverName, nodeType, region }) as unknown as ClusterNodeEntity;

function setup(
  cluster: Partial<ClusterEntity>,
  labels: Record<string, Record<string, string>>,
) {
  const added: Array<{ node: string; labels: Record<string, string> }> = [];
  const kubernetes = {
    listNodeLabels: jest.fn(async () => new Map(Object.entries(labels))),
    addNodeLabels: jest.fn(
      async (_k: string, nodeName: string, l: Record<string, string>) => {
        added.push({ node: nodeName, labels: l });
      },
    ),
  } as unknown as KubernetesService;
  const clusters = {
    findOne: jest.fn(async () => ({
      id: 'c1',
      name: 'lab',
      kubeconfigEncrypted: 'enc',
      ...cluster,
    })),
  } as unknown as Repository<ClusterEntity>;
  const encryption = {
    decrypt: () => 'kubeconfig',
  } as unknown as EncryptionService;
  const reconciler = new NodeTopologyReconciler(
    clusters,
    kubernetes,
    encryption,
    capabilities,
  );
  return { reconciler, added };
}

describe('labelling the nodes that joined before topology labels existed', () => {
  it('gives each Hetzner node its own location, and the master the cluster one', async () => {
    const { reconciler, added } = setup(
      {
        provider: 'hetzner',
        region: 'fsn1',
        nodes: [
          node('lab-master', NodeType.MASTER, null),
          node('lab-worker-1', NodeType.WORKER, 'nbg1'),
          node('lab-worker-3', NodeType.WORKER, 'hel1'),
        ],
      },
      { 'lab-master': {}, 'lab-worker-1': {}, 'lab-worker-3': {} },
    );
    const outcome = await reconciler.reconcile('c1');
    expect(outcome).toEqual({
      state: 'done',
      labelled: ['lab-master', 'lab-worker-1', 'lab-worker-3'],
      conflicts: [],
    });
    expect(
      added.map((a) => [a.node, a.labels['topology.kubernetes.io/zone']]),
    ).toEqual([
      ['lab-master', 'fsn1'],
      ['lab-worker-1', 'nbg1'],
      ['lab-worker-3', 'hel1'],
    ]);
    expect(
      added.every(
        (a) => a.labels['topology.kubernetes.io/region'] === 'eu-central',
      ),
    ).toBe(true);
  });

  /** A scaling group can buy in several locations, so a worker with no record is not placed by guess. */
  it('skips a worker whose location was never recorded', async () => {
    const { reconciler, added } = setup(
      {
        provider: 'hetzner',
        region: 'fsn1',
        nodes: [node('lab-worker-9', NodeType.WORKER, null)],
      },
      { 'lab-worker-9': {} },
    );
    await reconciler.reconcile('c1');
    expect(added).toEqual([]);
  });

  it('leaves a zone someone else set and reports it, still adding what is missing', async () => {
    const { reconciler, added } = setup(
      {
        provider: 'hetzner',
        region: 'fsn1',
        nodes: [node('lab-master', NodeType.MASTER, 'fsn1')],
      },
      { 'lab-master': { 'topology.kubernetes.io/zone': 'fsn1-dc14' } },
    );
    const outcome = await reconciler.reconcile('c1');
    expect(added).toEqual([
      {
        node: 'lab-master',
        labels: { 'topology.kubernetes.io/region': 'eu-central' },
      },
    ]);
    expect(outcome).toEqual({
      state: 'done',
      labelled: ['lab-master'],
      conflicts: ['lab-master: topology.kubernetes.io/zone=fsn1-dc14'],
    });
  });

  it('touches nothing on a node that already carries its labels', async () => {
    const { reconciler, added } = setup(
      {
        provider: 'hetzner',
        region: 'fsn1',
        nodes: [node('lab-master', NodeType.MASTER, 'fsn1')],
      },
      {
        'lab-master': {
          'topology.kubernetes.io/zone': 'fsn1',
          'topology.kubernetes.io/region': 'eu-central',
        },
      },
    );
    await reconciler.reconcile('c1');
    expect(added).toEqual([]);
  });

  it('labels nothing on a provider that declares no topology', async () => {
    const { reconciler, added } = setup(
      {
        provider: 'byos',
        region: null as unknown as string,
        nodes: [node('box', NodeType.MASTER, null)],
      },
      { box: {} },
    );
    await reconciler.reconcile('c1');
    expect(added).toEqual([]);
  });

  it('skips a cluster it cannot reach', async () => {
    const { reconciler } = setup(
      { kubeconfigEncrypted: null as unknown as string },
      {},
    );
    expect(await reconciler.reconcile('c1')).toEqual({
      state: 'skipped',
      reason: 'no kubeconfig',
    });
  });
});
