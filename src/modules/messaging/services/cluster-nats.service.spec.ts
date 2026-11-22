jest.mock('@kubernetes/client-node', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { ClusterNatsService, natsResolverUrl } from './cluster-nats.service';
import { NatsAccountsController } from '../controllers/nats-accounts.controller';
import { natsConfig } from '../nats/cluster-nats.manifest';

function build() {
  const rows: Record<string, unknown>[] = [];
  const operators = {
    findOne: jest.fn(
      async ({ where }: { where: Record<string, string> }) =>
        rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ??
        null,
    ),
    create: (v: Record<string, unknown>) => v,
    insert: jest.fn(async (v: Record<string, unknown>) => {
      rows.push(v);
    }),
  };
  const accounts = {
    findOne: jest.fn(async ({ where }: { where: { publicKey: string } }) =>
      where.publicKey === 'A'.padEnd(56, 'B') ? { jwt: 'app-jwt' } : null,
    ),
  };
  const applied: Array<Record<string, any>> = [];
  const k8s = {
    ensureNamespaceExists: jest.fn(),
    applyManifest: jest.fn(async (_kc: string, m: string) => {
      applied.push(JSON.parse(m));
    }),
  };
  const service = new ClusterNatsService(
    operators as never,
    accounts as never,
    { findOne: async () => ({ kubeconfigEncrypted: 'kc' }) } as never,
    k8s as never,
    { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v } as never,
  );
  return { service, rows, applied, operators };
}

describe('the NATS a cluster’s applications share', () => {
  const env = process.env.PUBLIC_API_URL;
  beforeEach(() => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
  });
  afterAll(() => {
    process.env.PUBLIC_API_URL = env;
  });

  it('asks the API’s public address for accounts', () => {
    expect(
      natsResolverUrl({ PUBLIC_API_URL: 'https://api.example.com/' }),
    ).toBe('https://api.example.com/api/v1/messaging/nats/accounts/');
    expect(
      natsResolverUrl({ API_BASE_URL: 'https://api.example.com/api/v1' }),
    ).toBe('https://api.example.com/api/v1/messaging/nats/accounts/');
    expect(() => natsResolverUrl({})).toThrow('PUBLIC_API_URL');
  });

  it('makes the operator once and keeps its seeds encrypted', async () => {
    const { service, rows } = build();
    const first = await service.operatorFor('c1');
    const again = await service.operatorFor('c1');
    expect(rows).toHaveLength(1);
    expect(again).toBe(first);
    expect(first.operatorSeed).toMatch(/^enc:SO/);
    expect(first.systemAccountSeed).toMatch(/^enc:SA/);
    expect(first.systemAccount).toMatch(/^A/);
  });

  it('puts a server on the cluster that holds nothing secret', async () => {
    const { service, applied } = build();
    await service.deploy('c1', '5Gi');
    expect(applied.map((m) => m.kind)).toEqual([
      'ConfigMap',
      'Service',
      'StatefulSet',
    ]);
    const conf = applied[0].data['nats.conf'] as string;
    expect(conf).toContain(
      'resolver: URL(https://api.example.com/api/v1/messaging/nats/accounts/)',
    );
    expect(conf).not.toMatch(/S[OAU][A-Z2-7]{50,}/);
    expect(applied[2].spec.template.spec.containers[0].image).toMatch(
      /-alpine$/,
    );
    expect(
      applied[2].spec.volumeClaimTemplates[0].spec.resources.requests.storage,
    ).toBe('5Gi');
  });

  it('restarts the server only when its configuration changes', async () => {
    const { service, applied } = build();
    await service.deploy('c1');
    await service.deploy('c1');
    const hashes = applied
      .filter((m) => m.kind === 'StatefulSet')
      .map(
        (m) => m.spec.template.metadata.annotations['flui.cloud/config-hash'],
      );
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('answers the server with the system account, an app account, or nothing', async () => {
    const { service } = build();
    const op = await service.operatorFor('c1');
    await expect(service.accountJwt(op.systemAccount)).resolves.toBe(
      op.systemAccountJwt,
    );
    await expect(service.accountJwt('A'.padEnd(56, 'B'))).resolves.toBe(
      'app-jwt',
    );
    await expect(service.accountJwt('A'.padEnd(56, 'C'))).resolves.toBeNull();
  });

  it('answers the probe on the base address and refuses anything that is not an account key', async () => {
    const controller = new NatsAccountsController({
      accountJwt: async () => 'jwt',
    } as never);
    expect(controller.root()).toBe('');
    await expect(controller.account('not-a-key')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.account('A'.padEnd(56, 'B'))).resolves.toBe('jwt');
  });

  it('writes a configuration nats-server reads', () => {
    expect(
      natsConfig({
        operatorJwt: 'eyJ',
        systemAccount: 'ASYS',
        resolverUrl: 'https://x/',
        storage: '1Gi',
      }),
    ).toBe(
      'port: 4222\nhttp: 8222\noperator: eyJ\nsystem_account: ASYS\nresolver: URL(https://x/)\njetstream {\n  store_dir: /data\n}\n',
    );
  });
});
