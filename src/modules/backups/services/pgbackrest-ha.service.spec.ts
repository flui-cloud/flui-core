jest.mock('@kubernetes/client-node', () => ({
  dumpYaml: (o: unknown) => JSON.stringify(o),
}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { PgBackrestHaService, describeFailure } from './pgbackrest-ha.service';

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
    mergePatchObject: jest.fn().mockResolvedValue(undefined),
    execInPod: jest.fn().mockResolvedValue(''),
    listPodsByLabel: jest
      .fn()
      .mockResolvedValue([
        { metadata: { name: 'orders-db-ha-1' } },
        { metadata: { name: 'orders-db-ha-2' } },
      ]),
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
  it('ships its log to a repository of its own, proven by a segment that reaches it', async () => {
    const { service, k8s, plugin } = build();
    k8s.execInPod.mockImplementation(async (...args: unknown[]) => {
      const script = (args[4] as string[])[2];
      if (script.includes('pg_switch_wal')) return '000000020000000000000011\n';
      if (script.includes('pg_stat_archiver')) return 't|\n';
      return '';
    });

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
      k8s.mergePatchObject.mock.calls.at(-1)[1].spec.plugins[0].isWALArchiver,
    ).toBe(true);
    const cleared = k8s.execInPod.mock.calls.filter((c) => c[5]);
    expect(cleared.map((c) => c[5])).toEqual([
      'orders-db-ha-1',
      'orders-db-ha-2',
    ]);
    expect(cleared[0][4][2]).toContain('postgresql.auto.conf');
    expect(
      k8s.execInPod.mock.calls.some((c) =>
        (c[4] as string[])[2].includes(
          "last_archived_wal >= '000000020000000000000011'",
        ),
      ),
    ).toBe(true);
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

  it('forgets the source of a promoted copy, and removes the plugin again when shipping never starts', async () => {
    const { service, k8s } = build();
    k8s.readObject.mockResolvedValue({
      spec: { replica: { enabled: false, source: 'flui-single' } },
    });
    Object.assign(service, {
      untilArchiving: jest
        .fn()
        .mockRejectedValue(new Error('not shipping: stanza missing')),
    });

    await expect(
      service.enable('a1', destination as never, {}),
    ).rejects.toThrow('stanza missing');

    const patches = k8s.mergePatchObject.mock.calls.map((c) => c[1].spec);
    expect(patches).toEqual([
      { replica: null },
      expect.objectContaining({ plugins: expect.any(Array) }),
      { plugins: null },
    ]);
  });

  it('reads the message of a failed exec, which is not an Error', () => {
    expect(
      describeFailure({
        status: 'Failure',
        message: 'command terminated with exit code 28',
      }),
    ).toBe('command terminated with exit code 28');
  });

  it('says why when the database is not highly available', async () => {
    const { service } = build(null);
    await expect(service.requireTooling('a1')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('the bases of a highly available repository, as its Stanza records them', () => {
  const { infoFromStanza, parseArchivedSince } = jest.requireActual(
    './pgbackrest-ha.util',
  );

  it('reads the window and the counts the plugin wrote, the way they looked live', () => {
    const base = {
      label: '20261108-192628F',
      type: 'full',
      timestamp: { start: 1794165988, stop: 1794165991 },
    };
    expect(
      infoFromStanza({
        backupsCount: { Diff: 0, Full: 1, Incr: 0 },
        recoveryWindow: { firstBackup: base, lastBackup: base },
      }),
    ).toEqual({
      latestLabel: '20261108-192628F',
      oldestRecoverable: new Date(1794165991000).toISOString(),
      newestRecoverable: new Date(1794165991000).toISOString(),
      lastFullAt: new Date(1794165991000).toISOString(),
      backupCount: 1,
      latestSizeBytes: null,
    });
    expect(infoFromStanza(undefined).backupCount).toBe(0);
  });

  it('reads whether a segment reached the repository, and the last that failed', () => {
    expect(parseArchivedSince('t|\n')).toEqual({ archived: true, failed: '' });
    expect(parseArchivedSince('f|000000020000000000000011')).toEqual({
      archived: false,
      failed: '000000020000000000000011',
    });
  });
});
