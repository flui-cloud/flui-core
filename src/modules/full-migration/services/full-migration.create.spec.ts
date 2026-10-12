jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { BadRequestException } from '@nestjs/common';
import { FullMigrationService } from './full-migration.service';

function setup(
  opts: {
    movable?: boolean;
    volumes?: boolean;
    pooled?: boolean;
    neighbours?: any[];
  } = {},
) {
  const app: any = {
    id: 'app-1',
    clusterId: 'src',
    volumes: opts.volumes ? [{ name: 'data', mountPath: '/data' }] : [],
  };
  const dbApp: any = {
    id: 'db-1',
    slug: 'pg-a',
    name: 'pg-a',
    clusterId: 'src',
    env: [{ name: 'POSTGRES_USER', value: 'u' }],
    pooler: opts.pooled ? { enabled: true, routed: true } : null,
  };
  const fmRepo = {
    findOne: jest.fn(async () => null),
    save: jest.fn(async (e: any) => ({ id: 'fm-1', ...e })),
    create: jest.fn((e: any) => e),
  };
  const opRepo = {
    save: jest.fn(async (e: any) => ({ id: 'op-1', ...e })),
    create: jest.fn((e: any) => e),
  };
  const clusterRepo = { findOne: jest.fn(async () => ({ id: 'dst' })) };
  const dbMigRepo = { findOne: jest.fn(async () => null) };
  const appMigRepo = { findOne: jest.fn(async () => null) };
  const appsRepo = {
    findById: jest.fn(async (id: string) => (id === 'app-1' ? app : dbApp)),
    findByClusterId: jest.fn(async () => [
      app,
      dbApp,
      ...(opts.neighbours ?? []),
    ]),
  };
  const appMig = {
    assertMovable: jest.fn(async () => {
      if (opts.movable === false) {
        throw new BadRequestException('IP-mode (nip.io) endpoint');
      }
    }),
  };
  const volumes = {
    hasVolumes: jest.fn((a: any) => (a.volumes ?? []).length > 0),
    plan: jest.fn(async () => ({ destinationId: 'dest-9' })),
  };
  const rewire = {
    assertRewirable: jest.fn(),
    referencesDb: jest.fn((a: any) => !!a.usesDb),
  };
  const queue = { add: jest.fn() };
  const svc = new FullMigrationService(
    fmRepo as any,
    opRepo as any,
    clusterRepo as any,
    dbMigRepo as any,
    appMigRepo as any,
    appsRepo as any,
    {} as any,
    {} as any,
    appMig as any,
    volumes as any,
    rewire as any,
    queue as any,
  );
  return { svc, fmRepo, opRepo, queue, volumes, appMig, rewire, appsRepo };
}

describe('FullMigrationService.create', () => {
  it('refuses an app the app leg could not move before any replication starts', async () => {
    const { svc, queue, fmRepo } = setup({ movable: false });
    await expect(
      svc.create('user-1', {
        appId: 'app-1',
        dbAppId: 'db-1',
        targetClusterId: 'dst',
      }),
    ).rejects.toThrow('nip.io');
    expect(queue.add).not.toHaveBeenCalled();
    expect(fmRepo.save).not.toHaveBeenCalled();
  });

  it('plans volumes through the requested destination and keeps it for the app leg', async () => {
    const { svc, volumes, fmRepo } = setup({ volumes: true });
    await svc.create('user-1', {
      appId: 'app-1',
      dbAppId: 'db-1',
      targetClusterId: 'dst',
      backupDestinationId: 'dest-9',
    });
    expect(volumes.plan).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app-1' }),
      'user-1',
      'dst',
      'dest-9',
    );
    expect(fmRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ backupDestinationId: 'dest-9' }),
    );
  });
});

describe('FullMigrationService.create with a pooled database', () => {
  const dto = { appId: 'app-1', dbAppId: 'db-1', targetClusterId: 'dst' };

  it('lets the app read the database Secret, checks the deadline and keeps it on the operation', async () => {
    const { svc, appMig, rewire, opRepo } = setup({ pooled: true });
    await svc.create('user-1', { ...dto, pauseDeadlineSeconds: 9 });
    expect(appMig.assertMovable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app-1' }),
      'dst',
      { allowSecretsOf: 'pg-a-secret' },
    );
    expect(rewire.assertRewirable).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { secretRefs: true },
    );
    expect(opRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ pauseDeadlineMs: 9000 }),
      }),
    );
  });

  it('refuses while another application uses the database, naming it', async () => {
    const { svc, queue } = setup({
      pooled: true,
      neighbours: [{ id: 'app-2', name: 'billing', usesDb: true }],
    });
    await expect(svc.create('user-1', dto)).rejects.toThrow(
      /Other applications use the database pg-a: billing/,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a deadline outside one to sixty seconds', async () => {
    const { svc } = setup({ pooled: true });
    await expect(
      svc.create('user-1', { ...dto, pauseDeadlineSeconds: 90 }),
    ).rejects.toThrow(/between 1 and 60/);
  });

  it('checks nothing more without a pooler on the source', async () => {
    const { svc, appMig, appsRepo, opRepo } = setup({
      neighbours: [{ id: 'app-2', name: 'billing', usesDb: true }],
    });
    await svc.create('user-1', dto);
    expect(appMig.assertMovable).toHaveBeenCalledWith(
      expect.anything(),
      'dst',
      {
        allowSecretsOf: undefined,
      },
    );
    expect(appsRepo.findByClusterId).not.toHaveBeenCalled();
    expect(
      opRepo.save.mock.calls[0][0].metadata.pauseDeadlineMs,
    ).toBeUndefined();
  });
});
