jest.mock('@kubernetes/client-node', () => ({
  CoreV1Api: class {},
  PolicyV1Api: class {},
}));

import { DrainFeasibilityService } from './drain-feasibility.service';
import {
  ClusterEntity,
  ClusterType,
} from '../../clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';

const parse = {
  parseCpu: (value: string) =>
    value.endsWith('m')
      ? Number.parseInt(value, 10)
      : Number.parseFloat(value) * 1000,
  parseMemory: (value: string) =>
    value.endsWith('Gi')
      ? Number.parseFloat(value) * 1024
      : Number.parseInt(value, 10),
};

interface NodeSpec {
  name: string;
  cpu: string;
  memory: string;
  controlPlane?: boolean;
  tainted?: boolean;
  cordoned?: boolean;
  ready?: boolean;
}

const node = (spec: NodeSpec) => ({
  metadata: {
    name: spec.name,
    labels: spec.controlPlane
      ? { 'node-role.kubernetes.io/control-plane': 'true' }
      : {},
  },
  spec: {
    unschedulable: spec.cordoned ?? false,
    taints: spec.tainted
      ? [{ key: 'flui.cloud/master-protection', effect: 'NoSchedule' }]
      : [],
  },
  status: {
    allocatable: { cpu: spec.cpu, memory: spec.memory },
    conditions: [
      { type: 'Ready', status: spec.ready === false ? 'False' : 'True' },
    ],
  },
});

const pod = (
  name: string,
  on: string,
  cpu: string,
  memory: string,
  owner = 'ReplicaSet',
) => ({
  metadata: { name, namespace: 'apps', ownerReferences: [{ kind: owner }] },
  spec: {
    nodeName: on,
    containers: [{ resources: { requests: { cpu, memory } } }],
  },
});

function build(nodes: unknown[], pods: unknown[], fails = false) {
  const coreApi = {
    listNode: jest.fn(async () => {
      if (fails) throw new Error('connection refused');
      return { items: nodes };
    }),
    listPodForAllNamespaces: jest.fn(async () => ({ items: pods })),
  };
  const kubernetes = {
    ...parse,
    makeKubeConfig: () => ({ makeApiClient: () => coreApi }),
  };
  const encryption = { decrypt: () => 'kubeconfig' };
  return new DrainFeasibilityService(
    {} as never,
    kubernetes as never,
    encryption as never,
  );
}

const cluster = (clusterType = ClusterType.WORKLOAD) =>
  ({ id: 'c1', clusterType, kubeconfigEncrypted: 'x' }) as ClusterEntity;
const leaving = {
  serverName: 'worker-2',
  nodeType: NodeType.WORKER,
} as ClusterNodeEntity;

describe('whether the work on a node has somewhere else to run', () => {
  it('finds room on a machine that stays, after what it already runs and the reserve', async () => {
    const service = build(
      [
        node({ name: 'worker-1', cpu: '2', memory: '4Gi' }),
        node({ name: 'worker-2', cpu: '2', memory: '4Gi' }),
      ],
      [
        pod('busy', 'worker-1', '1', '2Gi'),
        pod('api', 'worker-2', '500m', '1Gi'),
      ],
    );

    const fit = await service.roomElsewhere(cluster(), leaving);

    expect(fit?.fits).toBe(true);
    expect(fit?.room).toEqual({ cpuMillicores: 800, memoryMi: 1536 });
  });

  it('keeps the node when what it runs does not fit on the rest', async () => {
    const service = build(
      [
        node({ name: 'worker-1', cpu: '2', memory: '4Gi' }),
        node({ name: 'worker-2', cpu: '2', memory: '4Gi' }),
      ],
      [
        pod('busy', 'worker-1', '1', '3Gi'),
        pod('api', 'worker-2', '500m', '1Gi'),
      ],
    );

    const fit = await service.roomElsewhere(cluster(), leaving);

    expect(fit?.fits).toBe(false);
    expect(fit?.stranded).toEqual(['apps/api']);
  });

  it('does not move what runs on every machine', async () => {
    const service = build(
      [
        node({ name: 'worker-1', cpu: '1', memory: '1Gi' }),
        node({ name: 'worker-2', cpu: '2', memory: '4Gi' }),
      ],
      [pod('log-shipper', 'worker-2', '500m', '1Gi', 'DaemonSet')],
    );

    const fit = await service.roomElsewhere(cluster(), leaving);

    expect(fit?.fits).toBe(true);
    expect(fit?.needs).toEqual({ cpuMillicores: 0, memoryMi: 0 });
  });

  it.each([
    ['cordoned', { cordoned: true }],
    ['not ready', { ready: false }],
    ['refusing new work', { tainted: true }],
  ])('offers no room on a machine that is %s', async (_label, state) => {
    const service = build(
      [
        node({ name: 'worker-1', cpu: '8', memory: '16Gi', ...state }),
        node({ name: 'worker-2', cpu: '2', memory: '4Gi' }),
      ],
      [pod('api', 'worker-2', '100m', '128Mi')],
    );

    const fit = await service.roomElsewhere(cluster(), leaving);

    expect(fit?.fits).toBe(false);
  });

  it('counts the master of a control cluster once the last worker leaving is what reopens it', async () => {
    const nodes = [
      node({
        name: 'master',
        cpu: '4',
        memory: '8Gi',
        controlPlane: true,
        tainted: true,
      }),
      node({ name: 'worker-2', cpu: '2', memory: '4Gi' }),
    ];
    const pods = [pod('api', 'worker-2', '500m', '1Gi')];

    const control = await build(nodes, pods).roomElsewhere(
      cluster(ClusterType.CONTROL),
      leaving,
    );
    const workload = await build(nodes, pods).roomElsewhere(
      cluster(ClusterType.WORKLOAD),
      leaving,
    );

    expect(control?.fits).toBe(true);
    expect(workload?.fits).toBe(false);
  });

  it('answers nothing when the cluster cannot be asked', async () => {
    const service = build([], [], true);

    await expect(service.roomElsewhere(cluster(), leaving)).resolves.toBeNull();
    await expect(
      service.roomElsewhere(
        { ...cluster(), kubeconfigEncrypted: null } as unknown as ClusterEntity,
        leaving,
      ),
    ).resolves.toBeNull();
  });
});
