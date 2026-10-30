jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { ClusterNodeScalingService } from './cluster-node-scaling.service';
import { NodeResizeHaService } from './node-resize-ha.service';
import { NodeType } from '../entities/cluster-node.entity';
import {
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';

type Fake = Record<string, jest.Mock>;

function setup(
  opts: {
    ha?: 'three-locations' | 'standard';
    serverDown?: string;
    failChangeType?: boolean;
    primaryOnNode?: boolean;
  } = {},
) {
  const server = { status: 'running', server_type: 'cx22' };
  const provider: Fake = {
    changeServerType: jest.fn(async (_id, r: { targetServerType: string }) => {
      if (opts.failChangeType) throw new Error('provider refused the type');
      server.server_type = r.targetServerType;
    }),
    powerOffServer: jest.fn(async () => {
      server.status = 'off';
    }),
    powerOnServer: jest.fn(async () => {
      server.status = 'running';
    }),
    getServerDetailsAsDto: jest.fn(async () => ({ ...server })),
  };
  const operations = new Map<string, any>();
  const operationRepository: Fake = {
    create: jest.fn((o) => o),
    save: jest.fn(async (o) => {
      const saved = { id: o.id ?? 'op-1', ...o };
      operations.set(saved.id, saved);
      return saved;
    }),
    findOne: jest.fn(async ({ where }) => operations.get(where.id) ?? null),
    findOneOrFail: jest.fn(async ({ where }) => operations.get(where.id)),
    update: jest.fn(async (id, patch) => {
      operations.set(id, { ...operations.get(id), ...patch });
    }),
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        where: () => qb,
        andWhere: () => qb,
        getOne: async () => null,
      };
      return qb;
    }),
  };
  const node = {
    id: 'n-1',
    clusterId: 'c1',
    serverName: 'lab-worker-1',
    nodeType: NodeType.WORKER,
    providerResourceId: 'srv-1',
    region: 'nbg1',
  };
  const kubernetes: Fake = {
    cordonNode: jest.fn(),
    uncordonNode: jest.fn(),
    waitForNodeReady: jest.fn(),
    execInPod: jest.fn(async () => '[[]]'),
    listObjectsEverywhere: jest.fn(async () =>
      opts.primaryOnNode
        ? [
            {
              metadata: { namespace: 'p', name: 'db-ha' },
              status: { currentPrimary: 'db-ha-1' },
            },
          ]
        : [],
    ),
    listPodsByLabel: jest.fn(async () => [
      {
        metadata: { name: 'db-ha-1' },
        spec: { nodeName: 'lab-worker-1' },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      {
        metadata: { name: 'db-ha-2' },
        spec: { nodeName: 'lab-master' },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
    ]),
    jsonPatchObjectStatus: jest.fn(),
    readObject: jest.fn(async () => ({
      status: { currentPrimary: 'db-ha-2', phase: 'Cluster in healthy state' },
    })),
  };
  const queue = { add: jest.fn() };
  const serverNode = (name: string, zone: string, ready = true) => ({
    metadata: {
      name,
      labels: {
        'topology.kubernetes.io/zone': zone,
        'node-role.kubernetes.io/control-plane': 'true',
      },
    },
    status: {
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
    },
  });
  const clusterHa = {
    inspect: jest.fn(async () => ({
      kubeconfig: 'kc',
      nodes: [
        serverNode('lab-master', 'fsn1'),
        serverNode('lab-worker-1', 'nbg1'),
        serverNode('lab-worker-3', 'hel1', opts.serverDown !== 'lab-worker-3'),
      ],
      state: { level: opts.ha ?? 'three-locations' },
      topology: {
        zones: ['fsn1', 'nbg1', 'hel1'],
        dataZones: ['fsn1', 'nbg1'],
      },
    })),
  };
  const service = new ClusterNodeScalingService(
    {
      findOne: jest.fn(async () => ({
        id: 'c1',
        name: 'lab',
        provider: 'hetzner',
        region: 'fsn1',
        kubeconfigEncrypted: 'e',
      })),
    } as never,
    { findOne: jest.fn(async () => node), save: jest.fn() } as never,
    operationRepository as never,
    { find: jest.fn(async () => []) } as never,
    { getProvider: () => provider } as never,
    kubernetes as never,
    { decrypt: () => 'kc' } as never,
    { openNodeInterval: jest.fn() } as never,
    { resolveHourlyEur: jest.fn(async () => 0.01) } as never,
    queue as never,
    { candidatesFor: jest.fn(async () => []) } as never,
    new NodeResizeHaService(
      operationRepository as never,
      kubernetes as never,
      clusterHa as never,
      { runHostScript: jest.fn(async () => 'GROWN 40') } as never,
    ),
  );
  return { service, provider, queue, operations, kubernetes, server };
}

describe('resizing a node', () => {
  it('queues the work and answers at once', async () => {
    const { service, queue, provider } = setup({ ha: 'standard' });
    const op = await service.scaleNode('c1', 'n-1', {
      targetServerType: 'cx32',
    });
    expect(op.status).toBe(OperationStatus.PENDING);
    expect(op.operationType).toBe(OperationType.SCALE_NODE);
    expect(queue.add).toHaveBeenCalledWith(
      'scale-node',
      { operationId: 'op-1' },
      expect.any(Object),
    );
    expect(provider.powerOffServer).not.toHaveBeenCalled();
  });

  it('refuses on a cluster across three locations while another server is down', async () => {
    const { service, queue } = setup({ serverDown: 'lab-worker-3' });
    await expect(
      service.scaleNode('c1', 'n-1', { targetServerType: 'cx32' }),
    ).rejects.toThrow(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('runs the steps, hands a primary on the node over first, and grows the space for copies', async () => {
    const { service, provider, operations, kubernetes, server } = setup({
      primaryOnNode: true,
    });
    await service.scaleNode('c1', 'n-1', {
      targetServerType: 'cx32',
      copiesGiB: 40,
    });
    await service.runScaleNode('op-1');
    expect(kubernetes.jsonPatchObjectStatus).toHaveBeenCalledWith(
      'kc',
      expect.objectContaining({ name: 'db-ha', namespace: 'p' }),
      expect.arrayContaining([
        { op: 'replace', path: '/status/targetPrimary', value: 'db-ha-2' },
      ]),
    );
    expect(provider.powerOffServer).toHaveBeenCalled();
    expect(server).toEqual({ status: 'running', server_type: 'cx32' });
    expect(operations.get('op-1').status).toBe(OperationStatus.COMPLETED);
  });

  it('carries on where it was after a restart instead of starting over', async () => {
    const { service, provider, server, operations } = setup({ ha: 'standard' });
    await service.scaleNode('c1', 'n-1', { targetServerType: 'cx32' });
    server.status = 'off';
    server.server_type = 'cx32';
    await service.runScaleNode('op-1');
    expect(provider.powerOffServer).not.toHaveBeenCalled();
    expect(provider.changeServerType).not.toHaveBeenCalled();
    expect(provider.powerOnServer).toHaveBeenCalled();
    expect(operations.get('op-1').status).toBe(OperationStatus.COMPLETED);
  });

  it('powers the node back on when a step fails once it is off', async () => {
    const { service, provider, server, operations } = setup({
      ha: 'standard',
      failChangeType: true,
    });
    await service.scaleNode('c1', 'n-1', { targetServerType: 'cx32' });
    await service.runScaleNode('op-1');
    expect(provider.powerOnServer).toHaveBeenCalled();
    expect(server.status).toBe('running');
    const op = operations.get('op-1');
    expect(op.status).toBe(OperationStatus.FAILED);
    expect(op.errorMessage).toContain('The node powered back on');
  });
});
