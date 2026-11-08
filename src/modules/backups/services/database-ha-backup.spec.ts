jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { PostgresDumpService } from './logical-dump.service';
import { PgBackrestService } from './pgbackrest.service';

const app = {
  id: 'a1',
  slug: 'orders-db',
  clusterId: 'c1',
  k8sNamespace: 'ns',
  databaseHa: { cluster: 'orders-db-ha', state: 'active', instances: 3 },
};

const credentials = [
  {
    name: 'POSTGRES_PASSWORD',
    valueFrom: { secretKeyRef: { name: 'orders-db-secret', key: 'password' } },
  },
  { name: 'POSTGRES_USER', value: 'orders' },
];

describe('backing up a highly available Postgres', () => {
  it("dumps from the primary, through the application's address, with the credentials its single instance kept", async () => {
    const k8s = {
      listResourcesByLabel: jest.fn(async (_k: string, kind: string) =>
        kind === 'Pod'
          ? [
              {
                metadata: { labels: { 'cnpg.io/instanceRole': 'replica' } },
                status: { phase: 'Running' },
                spec: { containers: [{ name: 'postgres', image: 'cnpg' }] },
              },
              {
                metadata: { labels: { 'cnpg.io/instanceRole': 'primary' } },
                status: { phase: 'Running', podIP: '10.42.0.9' },
                spec: {
                  containers: [{ name: 'postgres', image: 'cnpg@sha256:1' }],
                },
              },
            ]
          : [
              {
                metadata: { name: 'orders-db-ha-r' },
                spec: { ports: [{ port: 5432 }] },
              },
              {
                metadata: { name: 'orders-db-svc' },
                spec: { ports: [{ port: 5432 }] },
              },
            ],
      ),
      readObject: jest.fn().mockResolvedValue({
        spec: {
          template: {
            spec: { containers: [{ name: 'orders-db', env: credentials }] },
          },
        },
      }),
    };
    const service = new PostgresDumpService(
      k8s as never,
      { decrypt: () => 'kc' } as never,
      { findOne: jest.fn().mockResolvedValue(app) } as never,
      {
        findOne: jest.fn().mockResolvedValue({ kubeconfigEncrypted: 'x' }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const target = await service.resolveTarget('a1');

    expect(target).toMatchObject({
      container: 'postgres',
      image: 'cnpg@sha256:1',
      host: 'orders-db-svc.ns.svc.cluster.local',
      env: credentials,
    });
  });

  it('leaves log shipping to pgBackRest only on a single instance', async () => {
    const service = new PgBackrestService(
      {} as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue(app) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.requireTooling('a1')).rejects.toThrow(
      BadRequestException,
    );
  });
});
