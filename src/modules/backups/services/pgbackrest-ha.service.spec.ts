jest.mock('@kubernetes/client-node', () => ({
  dumpYaml: (o: unknown) => JSON.stringify(o),
}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { PgBackrestHaService } from './pgbackrest-ha.service';

const ha = {
  engine: 'cnpg',
  cluster: 'orders-db-ha',
  durability: 'quorum',
  instances: 3,
  state: 'active',
  since: '2026-11-08T12:00:00Z',
};

function build(databaseHa: object | null = ha) {
  const k8s = {
    serverSideApply: jest.fn().mockResolvedValue(1),
    mergePatchObject: jest.fn(),
    execInPod: jest.fn().mockResolvedValue(''),
    readObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const plugin = { ensureInstalled: jest.fn() };
  const service = new PgBackrestHaService(
    k8s as never,
    { decrypt: (v: string) => `plain-${v}` } as never,
    {
      findOne: jest.fn().mockResolvedValue({
        id: 'a1',
        clusterId: 'c1',
        k8sNamespace: 'ns',
        databaseHa,
      }),
    } as never,
    {
      findOne: jest.fn().mockResolvedValue({ kubeconfigEncrypted: 'kc' }),
    } as never,
    { passphraseFor: jest.fn().mockResolvedValue('pass') } as never,
    {} as never,
    plugin as never,
  );
  Object.assign(service, { logger: { log: jest.fn() } });
  return { service, k8s, plugin };
}

const destination = {
  bucket: 'b',
  endpoint: 'https://fsn1.your-objectstorage.com',
  region: 'fsn1',
  pathPrefix: 'eu',
  forcePathStyle: false,
  accessKeyEncrypted: 'ak',
  secretKeyEncrypted: 'sk',
};

describe('continuous backup of a highly available Postgres', () => {
  it("ships its log to a repository of its own, proven by pgBackRest's check", async () => {
    const { service, k8s, plugin } = build();

    await service.enable('a1', destination as never, {
      generation: '20261108120000',
    });

    expect(plugin.ensureInstalled).toHaveBeenCalledWith('plain-kc');
    const applied = k8s.serverSideApply.mock.calls[0][1] as string;
    expect(applied).toContain(
      '"repoPath":"/eu/pgbackrest/a1/ha-20261108120000"',
    );
    expect(applied).toContain(
      '"flui.cloud/repository-prefix":"pgbackrest/a1/ha-20261108120000/"',
    );
    expect(applied).toContain('"ENCRYPTION_PASS":"pass"');
    expect(
      k8s.mergePatchObject.mock.calls[0][1].spec.plugins[0].isWALArchiver,
    ).toBe(true);
    expect(k8s.execInPod).toHaveBeenCalledWith(
      'plain-kc',
      'ns',
      'cnpg.io/cluster=orders-db-ha',
      'plugin-pgbackrest',
      ['sh', '-c', 'pgbackrest --stanza=main check'],
    );
  });

  it('returns the label of the base the plugin took', async () => {
    const { service, k8s } = build();
    k8s.readObject.mockResolvedValue({
      status: { phase: 'completed', backupId: '20261108-120500F' },
    });

    await expect(service.baseBackup('a1', 'full')).resolves.toBe(
      '20261108-120500F',
    );
    expect(k8s.serverSideApply.mock.calls[0][1]).toContain(
      '"backupType":"full"',
    );
  });

  it('says why when the database is not highly available', async () => {
    const { service } = build(null);
    await expect(service.requireTooling('a1')).rejects.toThrow(
      BadRequestException,
    );
  });
});
