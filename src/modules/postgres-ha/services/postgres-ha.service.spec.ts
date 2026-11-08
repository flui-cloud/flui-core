jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Queue } from 'bull';
import { ClusterHaService } from '../../cluster-ha/services/cluster-ha.service';
import { PostgresHaService } from './postgres-ha.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { postgresHaEligibility } from '../utils/postgres-ha-eligibility.core';

const flui = (over: Record<string, unknown> = {}) =>
  ({
    id: 'db-1',
    slug: 'orders-db',
    clusterId: 'c1',
    k8sNamespace: 'p-orders',
    workloadKind: 'StatefulSet',
    dedicatedNodeName: 'lab-worker-2',
    labels: { 'flui.cloud/db-engine': 'postgres' },
    sourceConfig: { imageRef: 'ghcr.io/flui-cloud/flui-postgres:17' },
    ...over,
  }) as unknown as ApplicationEntity;

const node = (name: string, zone: string) => ({
  metadata: { name, labels: { 'topology.kubernetes.io/zone': zone } },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
});

describe('which databases can be made highly available', () => {
  it("is Flui's own Postgres, and nothing else yet", () => {
    expect(postgresHaEligibility(flui())).toEqual({ eligible: true });
    expect(
      postgresHaEligibility(
        flui({ labels: { 'flui.cloud/db-engine': 'mariadb' } }),
      ),
    ).toMatchObject({ eligible: false });
    expect(
      postgresHaEligibility(
        flui({ sourceConfig: { imageRef: 'pgvector/pgvector:pg17' } }),
      ),
    ).toMatchObject({
      eligible: false,
      reason: expect.stringContaining('another image'),
    });
  });

  it('refuses a database already moving or moved, or on its way to another cluster', () => {
    for (const state of ['active', 'copying'] as const) {
      expect(
        postgresHaEligibility(flui({ databaseHa: { state } })),
      ).toMatchObject({ eligible: false });
    }
    expect(
      postgresHaEligibility(
        flui({ pooler: { enabled: true, upstream: { mode: 'forward' } } }),
      ),
    ).toMatchObject({ eligible: false });
    expect(
      postgresHaEligibility(flui({ databaseHa: { state: 'failed' } })),
    ).toEqual({ eligible: true });
  });

  it('lets a stopped attempt start again when nothing is running for it', () => {
    expect(
      postgresHaEligibility(flui({ databaseHa: { state: 'copying' } }), false),
    ).toEqual({ eligible: true });
  });
});

describe('asking for a highly available database', () => {
  function setup(app: ApplicationEntity, nodes: unknown[]) {
    const saved: Array<Partial<InfrastructureOperationEntity>> = [];
    const queued: unknown[] = [];
    const service = new PostgresHaService(
      {
        findOne: jest.fn(async () => app),
      } as unknown as Repository<ApplicationEntity>,
      {
        findOne: jest.fn(async () => ({
          id: 'c1',
          kubeconfigEncrypted: 'enc',
        })),
      } as unknown as Repository<ClusterEntity>,
      {
        create: (o: Partial<InfrastructureOperationEntity>) => o,
        count: jest.fn(async () => 0),
        save: jest.fn(async (o: Partial<InfrastructureOperationEntity>) => {
          saved.push(o);
          return { ...o, id: 'op-1' };
        }),
      } as unknown as Repository<InfrastructureOperationEntity>,
      {
        add: jest.fn(async (_name: string, data: unknown) => queued.push(data)),
      } as unknown as Queue,
      { listNodes: jest.fn(async () => nodes) } as unknown as KubernetesService,
      { decrypt: () => 'kubeconfig' } as unknown as EncryptionService,
      {
        requireThreeLocations: jest.fn(async () => {
          const zones = new Set(
            (
              nodes as Array<{ metadata: { labels: Record<string, string> } }>
            ).map((n) => n.metadata.labels['topology.kubernetes.io/zone']),
          );
          if (zones.size < 3) {
            throw new BadRequestException(
              'lab is not highly available across three locations yet',
            );
          }
          return {
            nodes,
            topology: {
              region: 'eu-central',
              zones: ['fsn1', 'nbg1', 'hel1'],
              dataZones: ['fsn1', 'nbg1'],
              validated: true,
              measured: true,
            },
          };
        }),
      } as unknown as ClusterHaService,
    );
    return { service, saved, queued };
  }

  const threeLocations = [
    node('lab-master', 'fsn1'),
    node('lab-worker-1', 'nbg1'),
    node('lab-worker-2', 'fsn1'),
    node('lab-worker-3', 'hel1'),
  ];

  it('queues the move with one instance per location and the primary in a close one', async () => {
    const { service, saved, queued } = setup(flui(), threeLocations);
    const result = await service.activate('db-1', {}, 'user-1');
    expect(result).toEqual({ operationId: 'op-1', durability: 'required' });
    expect(saved[0]).toMatchObject({
      operationType: OperationType.ACTIVATE_DATABASE_HA,
      resourceId: 'db-1',
      userId: 'user-1',
      metadata: { durability: 'required', zones: ['fsn1', 'nbg1', 'hel1'] },
    });
    expect(queued).toEqual([
      {
        operationId: 'op-1',
        appId: 'db-1',
        durability: 'required',
        preferredZones: ['fsn1', 'nbg1'],
      },
    ]);
  });

  it('refuses a cluster that is not highly available across three locations, and queues nothing', async () => {
    const { service, queued } = setup(flui(), threeLocations.slice(0, 3));
    await expect(service.activate('db-1', {})).rejects.toThrow(
      /three locations/,
    );
    expect(queued).toEqual([]);
  });

  it('refuses a database it cannot move, before touching the cluster', async () => {
    const { service, queued } = setup(
      flui({ labels: { 'flui.cloud/db-engine': 'redis' } }),
      [],
    );
    await expect(service.activate('db-1', {})).rejects.toThrow(
      /Only a PostgreSQL/,
    );
    expect(queued).toEqual([]);
  });

  /** Its continuous backup follows it to the cluster once the move ends. */
  it('moves a database its continuous backups cover', async () => {
    const { service, queued } = setup(flui(), threeLocations);
    await expect(service.activate('db-1', {})).resolves.toMatchObject({
      operationId: 'op-1',
    });
    expect(queued).toHaveLength(1);
  });
});

describe('the view of a highly available database', () => {
  it('reads where the primary is and how far behind each copy is', async () => {
    const execInPod = jest.fn(async () => 'orders-db-ha-2|quorum|3.1|3.4\n');
    const service = new PostgresHaService(
      {
        findOne: jest.fn(async () =>
          flui({
            databaseHa: {
              engine: 'cnpg',
              cluster: 'orders-db-ha',
              durability: 'required',
              instances: 3,
              state: 'active',
              since: 'x',
            },
          }),
        ),
      } as unknown as Repository<ApplicationEntity>,
      {
        findOne: jest.fn(async () => ({ id: 'c1', kubeconfigEncrypted: 'e' })),
      } as unknown as Repository<ClusterEntity>,
      {} as Repository<InfrastructureOperationEntity>,
      {} as Queue,
      {
        readObject: jest.fn(async () => ({
          status: { currentPrimary: 'orders-db-ha-1' },
        })),
        listPodsByLabel: jest.fn(async () => [
          {
            metadata: { name: 'orders-db-ha-1' },
            spec: { nodeName: 'lab-master' },
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          },
          {
            metadata: { name: 'orders-db-ha-2' },
            spec: { nodeName: 'lab-worker-1' },
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          },
        ]),
        listNodes: jest.fn(async () => [
          node('lab-master', 'fsn1'),
          node('lab-worker-1', 'nbg1'),
        ]),
        execInPod,
      } as unknown as KubernetesService,
      { decrypt: () => 'kubeconfig' } as unknown as EncryptionService,
      {} as ClusterHaService,
    );
    const view = await service.view('db-1');
    expect(view.placement).toMatchObject({
      primary: { instance: 'orders-db-ha-1', zone: 'fsn1' },
      copies: [
        {
          instance: 'orders-db-ha-2',
          zone: 'nbg1',
          confirms: true,
          flushLagMs: 3.1,
        },
      ],
    });
    expect(execInPod).toHaveBeenCalledWith(
      'kubeconfig',
      'p-orders',
      '',
      'postgres',
      expect.arrayContaining(['psql']),
      'orders-db-ha-1',
    );
  });
});
