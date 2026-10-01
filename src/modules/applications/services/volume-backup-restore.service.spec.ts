jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { VolumeBackupRestoreService } from './volume-backup-restore.service';
import { VolumeBackupLookupService } from './volume-backup-lookup.service';
import { deriveKopiaPassword } from '../../backups/utils/kopia-repository.util';
import { deriveCryptPasswords } from '../../backups/utils/rclone-crypt.util';

const PASSPHRASE = 'dest-passphrase';
const record = {
  snapshotId: 'aaaa0000bbbb1111cccc2222dddd3333',
  rootObject: 'kf0c',
  source: 'flui@flui-app-1:/flui/volumes/data-web',
  sqlite: {
    snapshotId: 'eeee0000ffff1111',
    rootObject: 'kaaa',
    source: 'flui@flui-app-1:/flui/sqlite/data-web/data',
  },
  repositoryPrefix: 'kopia/app-1/',
  compression: 'zstd-fastest',
  encryption: 'AES256-GCM-HMAC-SHA256',
  splitter: 'DYNAMIC-1M-BUZHASH',
  pinned: true,
  kopiaVersion: '0.23.1',
};

function artifact(
  summary: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'art-1',
    applicationId: 'app-1',
    volumeName: 'data-web',
    engineClass: 'volume_copy',
    backupJobId: 'job-1',
    manifestSummary: { sourceSizeGb: 5, ...summary },
    locations: [
      {
        state: 'available',
        destinationId: 'dest-1',
        objectKeyPrefix:
          (summary as any).repository?.objectKeyPrefix ?? 'kopia/app-1/',
      },
    ],
    ...extra,
  };
}

function make(row: any) {
  const service = Object.create(
    VolumeBackupRestoreService.prototype,
  ) as VolumeBackupRestoreService;
  const r = service as any;
  r.logger = { log: jest.fn(), warn: jest.fn() };
  r.artifactRepo = {
    findOne: jest.fn(async () => row),
    find: jest.fn(async () => [row]),
    delete: jest.fn(async () => undefined),
    count: jest.fn(async () => 1),
  };
  r.locationRepo = { delete: jest.fn(async () => undefined) };
  r.jobRepo = {
    findOne: jest.fn(async () => ({ id: 'job-1', policyId: 'pol-1' })),
    delete: jest.fn(async () => undefined),
  };
  r.destinationRepo = {
    findOne: async () => ({
      id: 'dest-1',
      name: 'scw',
      provider: 'scaleway_object_storage',
      bucket: 'b',
      endpoint: 'https://s3.fr-par.scw.cloud',
      region: 'fr-par',
      pathPrefix: 'flui/x',
    }),
  };
  r.clusterRepo = {
    findOne: async () => ({ id: 'cl-1', kubeconfigEncrypted: 'kc' }),
  };
  r.applications = {
    findById: jest.fn(async (id: string) => ({
      id,
      slug: id === 'app-1' ? 'web' : 'web-copy',
      k8sNamespace: `ns-${id}`,
      clusterId: 'cl-1',
    })),
  };
  r.appResources = { findByApplicationId: async () => [] };
  r.volumeClaims = {
    resolveForApplication: async () => [
      {
        name: 'data-web',
        storageClass: 'flui-local',
        requestedBytes: 10 * 1024 ** 3,
      },
    ],
  };
  r.destinations = {
    toCredentials: () => ({
      provider: 'scaleway_object_storage',
      bucket: 'b',
      endpoint: 'https://s3.fr-par.scw.cloud',
      region: 'fr-par',
      pathPrefix: 'flui/x',
      accessKey: 'AK',
      secretKey: 'SK',
    }),
    decryptPassphrase: () => PASSPHRASE,
  };
  r.encryption = { decrypt: (v: string) => `plain-${v}` };
  r.kopiaCli = {
    listDirectories: jest.fn(async () => [
      { found: true, isFile: false, entries: [{ name: 'uploads', type: 'd' }] },
      {
        found: true,
        isFile: false,
        entries: [{ name: 'app.db', type: 'f', size: 4 }],
      },
    ]),
    deleteSnapshots: jest.fn(async () => undefined),
  };
  r.kopia = {
    sourceVolume: async () => ({ sizeGb: 10, nodeName: 'node-a' }),
    createVolume: jest.fn(async () => undefined),
    restore: jest.fn(async () => ({ bytes: 1 })),
  };
  r.volumeExport = { restoreFromExport: jest.fn(async () => ({})) };
  r.runner = {
    run: async (_meta: unknown, fn: () => Promise<unknown>) => ({
      result: await fn(),
      operationId: 'op-1',
    }),
  };
  r.access = { assertCan: jest.fn(async () => undefined) };
  r.storage = {
    forProvider: () => ({
      listObjects: jest.fn(async () => ({ keys: ['k1'], hasMore: false })),
      deleteObjects: jest.fn(async () => undefined),
    }),
  };
  r.lookup = Object.assign(
    Object.create(VolumeBackupLookupService.prototype),
    r,
  );
  return { service, r };
}

describe('restoring a volume backup: kopia or the archive it replaced', () => {
  it('restores a kopia snapshot into a new volume through a kopia Job', async () => {
    const { service, r } = make(
      artifact({ sink: 'kopia', kopia: record }, { engine: 'kopia' }),
    );
    const res = await service.restore('app-1', 'art-1', {});
    expect(res).toMatchObject({
      engine: 'kopia',
      targetApplicationId: 'app-1',
      replaces: 'data-web',
    });
    expect(res.newPvcName).toMatch(/^data-web-restored-\d{14}$/);
    expect(r.kopia.createVolume).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'ns-app-1',
        storageClassName: 'flui-local',
        sizeGb: 10,
      }),
    );
    const call = r.kopia.restore.mock.calls[0][0];
    expect(call.credentials.password).toBe(
      deriveKopiaPassword(PASSPHRASE, 'app-1'),
    );
    expect(call.job).toMatchObject({
      repositoryAppId: 'app-1',
      targetPvcName: res.newPvcName,
      primarySnapshotId: record.snapshotId,
      sqliteSnapshotId: record.sqlite.snapshotId,
      nodeName: 'node-a',
      location: { prefix: 'flui/x/kopia/app-1/' },
    });
    expect(call.job.paths).toBeUndefined();
    expect(r.volumeExport.restoreFromExport).not.toHaveBeenCalled();
  });

  it('restores an rclone archive from before kopia through its own path, decrypting it', async () => {
    const { service, r } = make(
      artifact({
        sink: 's3-archive',
        repository: {
          objectKeyPrefix: 'flui/x/exports/web/2026',
          cipher: 'rclone-crypt-v1',
        },
      }),
    );
    const res = await service.restore('app-1', 'art-1', {});
    expect(res.engine).toBe('rclone');
    expect(r.kopia.restore).not.toHaveBeenCalled();
    expect(r.volumeExport.restoreFromExport).toHaveBeenCalledWith(
      expect.objectContaining({
        sink: 's3-archive',
        exportId: 'flui/x/exports/web/2026',
        newPvcName: res.newPvcName,
        encryption: deriveCryptPasswords(PASSPHRASE),
        s3: expect.objectContaining({ bucket: 'b', accessKeyId: 'AK' }),
      }),
    );
  });

  it('sends a clone to the snapshot restore', async () => {
    const { service } = make(
      artifact({ sink: 'pvc-clone', clonePvcName: 'web-snap' }),
    );
    await expect(service.restore('app-1', 'art-1', {})).rejects.toThrow(
      /app snapshot restore/,
    );
  });

  it('restores into another application only for a caller who may change it', async () => {
    const { service, r } = make(
      artifact({ sink: 'kopia', kopia: record }, { engine: 'kopia' }),
    );
    const user = { userId: 'u1' } as any;
    const res = await service.restore(
      'app-1',
      'art-1',
      { targetApplicationId: 'app-2' },
      user,
    );
    expect(r.access.assertCan).toHaveBeenCalledWith(
      user,
      'app:write',
      expect.objectContaining({ id: 'app-2' }),
    );
    expect(res.targetApplicationId).toBe('app-2');
    expect(r.kopia.restore.mock.calls[0][0].job).toMatchObject({
      namespace: 'ns-app-2',
      repositoryAppId: 'app-1',
    });

    r.access.assertCan.mockRejectedValueOnce(new ForbiddenException('no'));
    await expect(
      service.restore('app-1', 'art-1', { targetApplicationId: 'app-2' }, user),
    ).rejects.toThrow(ForbiddenException);
  });

  it('restores selected paths into the live volume, only from kopia', async () => {
    const { service, r } = make(
      artifact({ sink: 'kopia', kopia: record }, { engine: 'kopia' }),
    );
    const res = await service.restoreFiles('app-1', 'art-1', {
      paths: ['/uploads/a.pdf', 'app.db'],
      targetDirectory: 'restored/',
    });
    expect(res).toMatchObject({
      volumeName: 'data-web',
      paths: ['uploads/a.pdf', 'app.db'],
      targetDirectory: 'restored',
    });
    expect(r.kopia.restore.mock.calls[0][0].job).toMatchObject({
      targetPvcName: 'data-web',
      paths: ['uploads/a.pdf', 'app.db'],
      targetDirectory: 'restored',
    });
    await expect(
      service.restoreFiles('app-1', 'art-1', { paths: ['../x'] }),
    ).rejects.toThrow(BadRequestException);

    const legacy = make(artifact({ sink: 's3-archive' }));
    await expect(
      legacy.service.restoreFiles('app-1', 'art-1', { paths: ['a'] }),
    ).rejects.toThrow(/Only kopia backups/);
  });

  it('lists a directory from the volume and its SQLite copies together', async () => {
    const { service, r } = make(
      artifact({ sink: 'kopia', kopia: record }, { engine: 'kopia' }),
    );
    const listing = await service.browse('app-1', 'art-1', '/');
    expect(r.kopiaCli.listDirectories).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        password: deriveKopiaPassword(PASSPHRASE, 'app-1'),
      }),
      ['kf0c', 'kaaa'],
      '',
    );
    expect(listing.entries.map((e) => e.name)).toEqual(['uploads', 'app.db']);
    expect(listing.entries[1].consistentCopy).toBe(true);
  });

  it('deletes a kopia snapshot and its row, keeping the policy run it belonged to', async () => {
    const { service, r } = make(
      artifact({ sink: 'kopia', kopia: record }, { engine: 'kopia' }),
    );
    await service.remove('app-1', 'art-1');
    expect(r.kopiaCli.deleteSnapshots).toHaveBeenCalledWith(expect.anything(), [
      record.snapshotId,
      record.sqlite.snapshotId,
    ]);
    expect(r.artifactRepo.delete).toHaveBeenCalledWith({ id: 'art-1' });
    expect(r.jobRepo.delete).not.toHaveBeenCalled();
  });
});
