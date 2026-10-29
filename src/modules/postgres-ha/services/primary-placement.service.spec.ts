jest.mock('@kubernetes/client-node', () => ({}));

import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterHaService } from '../../cluster-ha/services/cluster-ha.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { PrimaryPlacementService } from './primary-placement.service';

const node = (name: string, zone: string) => ({
  metadata: { name, labels: { 'topology.kubernetes.io/zone': zone } },
});

const pod = (name: string, nodeName: string) => ({
  metadata: { name },
  spec: { nodeName },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
});

const app = (over: Record<string, unknown> = {}) =>
  ({
    id: 'db-1',
    slug: 'orders-db',
    clusterId: 'c1',
    k8sNamespace: 'p-orders',
    databaseHa: {
      engine: 'cnpg',
      cluster: 'orders-db-ha',
      durability: 'required',
      instances: 3,
      state: 'active',
      since: '2026-10-29T08:00:00.000Z',
    },
    ...over,
  }) as unknown as ApplicationEntity;

function setup(primary: string, opts: { validated?: boolean } = {}) {
  const validated = opts.validated ?? true;
  const update = jest.fn();
  const patch = jest.fn();
  const apps = { update } as unknown as Repository<ApplicationEntity>;
  const kubernetes = {
    readObject: jest.fn().mockResolvedValue({
      spec: { instances: 3 },
      status: {
        currentPrimary: primary,
        phase: 'Cluster in healthy state',
        readyInstances: 3,
      },
    }),
    listPodsByLabel: jest
      .fn()
      .mockResolvedValue([
        pod('orders-db-ha-1', 'master'),
        pod('orders-db-ha-2', 'w1'),
        pod('orders-db-ha-3', 'w3'),
      ]),
    jsonPatchObjectStatus: patch,
  } as unknown as KubernetesService;
  const clusterHa = {
    inspect: jest.fn().mockResolvedValue({
      kubeconfig: 'kc',
      nodes: [node('master', 'fsn1'), node('w1', 'nbg1'), node('w3', 'hel1')],
      state: { level: 'three-locations' },
      topology: {
        region: 'eu-central',
        zones: ['fsn1', 'nbg1', 'hel1'],
        dataZones: validated ? ['fsn1', 'nbg1'] : ['fsn1', 'nbg1', 'hel1'],
        validated,
      },
    }),
  } as unknown as ClusterHaService;
  return {
    service: new PrimaryPlacementService(apps, kubernetes, clusterHa),
    update,
    patch,
  };
}

describe('PrimaryPlacementService', () => {
  it('switches a primary that sits in the voting location over to a copy in a location for data', async () => {
    const { service, patch, update } = setup('orders-db-ha-3');
    await service.check(app());
    expect(patch).toHaveBeenCalledWith(
      'kc',
      expect.objectContaining({ plural: 'clusters', name: 'orders-db-ha' }),
      expect.arrayContaining([
        {
          op: 'replace',
          path: '/status/targetPrimary',
          value: 'orders-db-ha-1',
        },
        {
          op: 'replace',
          path: '/status/phase',
          value: 'Switchover in progress',
        },
      ]),
    );
    expect(update).toHaveBeenCalledWith('db-1', {
      databaseHa: expect.objectContaining({
        primaryMovedAt: expect.any(String),
      }),
    });
  });

  it('leaves a primary already in a location for data alone', async () => {
    const { service, patch } = setup('orders-db-ha-2');
    await service.check(app());
    expect(patch).not.toHaveBeenCalled();
  });

  it('does not move anything on a forced region, where every location counts as one for data', async () => {
    const { service, patch } = setup('orders-db-ha-3', { validated: false });
    await service.check(app());
    expect(patch).not.toHaveBeenCalled();
  });

  it('waits after a move instead of chasing the primary again', async () => {
    const { service, patch } = setup('orders-db-ha-3');
    const spec = app().databaseHa!;
    await service.check(
      app({
        databaseHa: { ...spec, primaryMovedAt: new Date().toISOString() },
      }),
    );
    expect(patch).not.toHaveBeenCalled();
  });
});
