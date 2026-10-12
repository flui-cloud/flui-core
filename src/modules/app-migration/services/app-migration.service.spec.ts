jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { ConflictException } from '@nestjs/common';
import { AppMigrationService } from './app-migration.service';
import { AppMigrationStatus } from '../enums/app-migration.enum';
import { HostnameMode } from '../../dns/enums/hostname-mode.enum';

const SRC = 'cluster-src';
const DST = 'cluster-dst';

function setup(
  opts: {
    status?: AppMigrationStatus;
    bridgeState?: any;
    appCluster?: string;
    endpoints?: any[];
    sharedWith?: any[];
    liveJobs?: any[];
  } = {},
) {
  const calls: string[] = [];
  const app: any = {
    id: 'app-1',
    name: 'shop',
    slug: 'shop',
    clusterId: opts.appCluster ?? DST,
    env: [],
  };
  const mig: any = {
    id: 'mig-1',
    srcAppId: app.id,
    srcClusterId: SRC,
    targetClusterId: DST,
    status: opts.status ?? AppMigrationStatus.COMPLETED,
    bridgeState: opts.bridgeState ?? {
      mode: 'dns-only',
      skipReason: 'off',
      state: null,
      hosts: [],
    },
  };
  const endpoints = opts.endpoints ?? [
    {
      id: 'ep-1',
      fqdn: 'shop.example.com',
      applicationId: app.id,
      clusterId: DST,
      hostnameMode: HostnameMode.DOMAIN,
    },
  ];
  const migRepo = {
    findOne: jest.fn(async ({ where }: any) =>
      where.id === mig.id ? mig : null,
    ),
    find: jest.fn(async () => [mig]),
    save: jest.fn(async (m: any) => m),
    create: jest.fn((m: any) => m),
  };
  const endpointRepo = {
    find: jest.fn(async ({ where }: any) =>
      where.fqdn ? [...endpoints, ...(opts.sharedWith ?? [])] : endpoints,
    ),
  };
  const materializer = {
    teardownOnCluster: jest.fn(async (_a: any, c: string) => {
      calls.push(`teardown:${c}`);
    }),
  };
  const reconciliation = {
    deleteEndpointResources: jest.fn(async (id: string, o: any) => {
      calls.push(`delete-route:${id}:${o?.clusterId}`);
    }),
  };
  const bridge = {
    close: jest.fn(async () => {
      calls.push('close');
      return null;
    }),
    discard: jest.fn(async () => {
      calls.push('discard');
    }),
    preflight: jest.fn(async () => ({ mode: 'bridge', skipReason: null })),
    zonesMissingOn: jest.fn(async () => []),
  };
  const legs = {
    rollbackBridge: jest.fn(async (m: any) => {
      calls.push('rollback-bridge');
      m.bridgeState = { ...m.bridgeState, state: 'preparing' };
      m.status = AppMigrationStatus.READY;
    }),
  };
  const queue = {
    add: jest.fn(),
    getJobs: jest.fn(async () => opts.liveJobs ?? []),
  };
  const opRepo = {
    update: jest.fn(),
    save: jest.fn(async (o: any) => ({ id: 'op-1', ...o })),
    create: jest.fn((o: any) => o),
  };
  const service = new (AppMigrationService as any)(
    migRepo,
    { findOne: jest.fn(async () => app) },
    { findOne: jest.fn(async () => ({ id: DST })) },
    opRepo,
    endpointRepo,
    queue,
    materializer,
    { hasVolumes: () => false },
    reconciliation,
    bridge,
    legs,
  );
  return {
    service,
    calls,
    mig,
    app,
    bridge,
    queue,
    migRepo,
    reconciliation,
    legs,
  };
}

describe('destroying the source after a DNS-only migration', () => {
  it('removes the routes the application left on the source, keeping its DNS', async () => {
    const { service, calls, mig } = setup();

    await service.destroySource(mig.id);

    expect(calls).toEqual([`delete-route:ep-1:${SRC}`, `teardown:${SRC}`]);
    expect(mig.sourceDestroyedAt).toBeInstanceOf(Date);
  });

  it('never strips a route that is still served from the source', async () => {
    const { service, calls, mig } = setup({
      endpoints: [{ id: 'ep-1', fqdn: 'shop.example.com', clusterId: SRC }],
    });

    await service.destroySource(mig.id);

    expect(calls).toEqual([`teardown:${SRC}`]);
  });

  it('refuses a second destroy', async () => {
    const { service, mig } = setup();
    mig.sourceDestroyedAt = new Date();

    await expect(service.destroySource(mig.id)).rejects.toThrow(/already/);
  });
});

describe('destroying the source while the bridge is open', () => {
  const active = (flippedSecondsAgo: number) => ({
    mode: 'bridge',
    skipReason: null,
    state: 'active',
    hosts: [],
    activatedAt: new Date(Date.now() - 600_000).toISOString(),
    dnsFlippedAt: new Date(Date.now() - flippedSecondsAgo * 1000).toISOString(),
    recordTtlSeconds: 300,
  });

  it('answers 409 while cached answers may still point at the source', async () => {
    const { service, mig, calls } = setup({
      status: AppMigrationStatus.BRIDGING,
      bridgeState: active(60),
    });

    const attempt = service.destroySource(mig.id);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(service.destroySource(mig.id)).rejects.toThrow(/closeBridge/);
    expect(calls).toEqual([]);
    expect(mig.status).toBe(AppMigrationStatus.BRIDGING);
  });

  it('closes the bridge first when asked to close it now', async () => {
    const { service, mig, calls } = setup({
      status: AppMigrationStatus.BRIDGING,
      bridgeState: active(60),
    });

    await service.destroySource(mig.id, { closeBridge: true });

    expect(calls).toEqual([
      'close',
      `delete-route:ep-1:${SRC}`,
      `teardown:${SRC}`,
    ]);
    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
    expect(mig.bridgeState.state).toBe('closed');
    expect(mig.sourceDestroyedAt).toBeInstanceOf(Date);
  });

  it('closes without being asked once twice the record TTL has passed', async () => {
    const { service, mig, calls } = setup({
      status: AppMigrationStatus.BRIDGING,
      bridgeState: active(601),
    });

    await service.destroySource(mig.id);

    expect(calls[0]).toBe('close');
    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
  });
});

describe('AppMigrationService.assertMovable', () => {
  it('refuses a database with a pooler and names the database migration instead', async () => {
    const { service, app, migRepo } = setup();
    app.pooler = { enabled: true, mode: 'transaction' };

    await expect(service.assertMovable(app, DST)).rejects.toThrow(
      /pooler.*flui migrate db.*flui migrate full/,
    );
    expect(migRepo.findOne).not.toHaveBeenCalled();
  });

  it('lets an app read the Secret of the database moving with it, and nothing else', async () => {
    const { service, app } = setup();
    app.env = [
      {
        name: 'DATABASE_URL',
        value: '',
        externalSecretRef: {
          secretName: 'pg-a-secret',
          key: 'FLUI_CONNECTION_URL',
        },
      },
    ];
    await expect(service.assertMovable(app, DST)).rejects.toThrow(
      /reads variables from a secret it does not own \(pg-a-secret\)/,
    );
    await expect(
      service.assertMovable(app, DST, { allowSecretsOf: 'pg-a-secret' }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertMovable(app, DST, { allowSecretsOf: 'pg-b-secret' }),
    ).rejects.toThrow(/secret it does not own \(pg-a-secret\)/);
  });

  it('moves a database whose pooler was turned off', async () => {
    const { service, app } = setup();
    app.pooler = { enabled: false, mode: 'transaction' };

    await expect(service.assertMovable(app, DST)).resolves.toBeUndefined();
  });

  it('refuses a hostname shared with an application that is not moving', async () => {
    const { service, app } = setup({
      sharedWith: [
        {
          id: 'ep-9',
          fqdn: 'shop.example.com',
          applicationId: 'app-other',
          routePath: '/blog',
        },
      ],
    });

    await expect(service.assertMovable(app)).rejects.toThrow(
      /shop\.example\.com.*app-other/,
    );
  });

  it('refuses a destination without the DNS zone of an endpoint', async () => {
    const { service, app, bridge } = setup();
    bridge.zonesMissingOn.mockResolvedValueOnce(['example.com']);

    await expect(service.assertMovable(app, DST)).rejects.toThrow(
      /example\.com/,
    );
  });
});

describe('abort and resume around the bridge', () => {
  it('refuses to abort once the bridge has been opened', async () => {
    const { service, mig } = setup({
      status: AppMigrationStatus.FAILED,
      appCluster: SRC,
      bridgeState: { mode: 'bridge', state: 'active', hosts: [] },
    });

    await expect(service.abort(mig.id)).rejects.toThrow(/bridge/);
  });

  it('removes the certificates prepared on the destination when aborted before cutover', async () => {
    const { service, mig, calls } = setup({
      status: AppMigrationStatus.READY,
      appCluster: SRC,
      bridgeState: { mode: 'bridge', state: 'preparing', hosts: [{}] },
    });

    await service.abort(mig.id);

    expect(calls).toContain('discard');
    expect(mig.status).toBe(AppMigrationStatus.ABORTED);
  });

  it('removes the route prepared on the destination when aborted before cutover', async () => {
    const { service, mig, calls } = setup({
      status: AppMigrationStatus.READY,
      appCluster: SRC,
      endpoints: [{ id: 'ep-1', fqdn: 'shop.example.com', clusterId: SRC }],
      bridgeState: {
        mode: 'bridge',
        state: 'preparing',
        hosts: [{}],
        routePrepared: true,
      },
    });

    await service.abort(mig.id);

    expect(calls).toContain(`delete-route:ep-1:${DST}`);
  });

  it('accepts the cutover again after a failure past activation', async () => {
    const { service, mig, queue } = setup({
      status: AppMigrationStatus.FAILED,
      bridgeState: { mode: 'bridge', state: 'active', hosts: [] },
    });

    await service.cutover(mig.id);

    expect(queue.add).toHaveBeenCalled();
  });

  it('keeps refusing the cutover of a failure before activation', async () => {
    const { service, mig } = setup({
      status: AppMigrationStatus.FAILED,
      bridgeState: { mode: 'bridge', state: 'preparing', hosts: [] },
    });

    await expect(service.cutover(mig.id)).rejects.toThrow(/only available/);
  });
});

describe('creating a migration records the bridge decision', () => {
  it('asks the bridge preflight and keeps its verdict', async () => {
    const { service, bridge, migRepo } = setup({ appCluster: SRC });

    await service.create('user-1', {
      srcAppId: 'app-1',
      targetClusterId: DST,
      bridge: false,
    });

    expect(bridge.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceClusterId: SRC,
        targetClusterId: DST,
        requested: false,
      }),
    );
    expect(migRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeState: expect.objectContaining({ mode: 'bridge' }),
      }),
    );
  });
});

describe('resuming a cutover interrupted by a restart', () => {
  it('accepts the cutover again when no job is left running it', async () => {
    const { service, mig, queue } = setup({
      status: AppMigrationStatus.CUTOVER,
      appCluster: SRC,
    });

    await service.cutover(mig.id);

    expect(queue.add).toHaveBeenCalledWith(expect.any(String), {
      migrationId: mig.id,
    });
  });

  it('refuses while a job still runs it', async () => {
    const { service, mig, queue } = setup({
      status: AppMigrationStatus.CUTOVER,
      liveJobs: [{ data: { migrationId: 'mig-1' } }],
    });

    await expect(service.cutover(mig.id)).rejects.toThrow(/still running/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('tells every surface when a cutover can be resumed', async () => {
    const stuck = setup({ status: AppMigrationStatus.CUTOVER });
    expect((await stuck.service.getView('mig-1')).canResumeCutover).toBe(true);

    const running = setup({
      status: AppMigrationStatus.CUTOVER,
      liveJobs: [{ data: { migrationId: 'mig-1' } }],
    });
    expect((await running.service.getView('mig-1')).canResumeCutover).toBe(
      false,
    );

    const failedOpen = setup({
      status: AppMigrationStatus.FAILED,
      bridgeState: { mode: 'bridge', state: 'active', hosts: [] },
    });
    expect(
      (await failedOpen.service.listViews('user-1'))[0].canResumeCutover,
    ).toBe(true);

    const ready = setup({ status: AppMigrationStatus.READY });
    expect((await ready.service.getView('mig-1')).canResumeCutover).toBe(false);
  });

  it('re-queues, at startup, the cutovers no job is running', async () => {
    const { service, queue } = setup({ status: AppMigrationStatus.CUTOVER });

    await service.onModuleInit();

    expect(queue.add.mock.calls[0][1]).toEqual({ migrationId: 'mig-1' });
  });
});

describe('the bridge opened ahead of the cutover by a full migration', () => {
  const active = { mode: 'bridge', state: 'active', hosts: [] };

  it('queues the bridge opening for a leg parked at READY', async () => {
    const { service, mig, queue } = setup({
      status: AppMigrationStatus.READY,
      appCluster: SRC,
      bridgeState: { mode: 'bridge', state: 'preparing', hosts: [] },
    });
    mig.fullMigrationId = 'fm-1';

    await service.openBridge(mig.id, true);

    expect(queue.add).toHaveBeenCalledWith('run-app-bridge-open', {
      migrationId: mig.id,
    });
  });

  it('refuses to open it for a migration that is not a leg', async () => {
    const { service, mig } = setup({
      status: AppMigrationStatus.READY,
      appCluster: SRC,
      bridgeState: { mode: 'bridge', state: 'preparing', hosts: [] },
    });

    await expect(service.openBridge(mig.id)).rejects.toThrow(/full migration/);
  });

  it('rolls the bridge back, then tears down, when the orchestrator aborts', async () => {
    const { service, mig, calls } = setup({
      status: AppMigrationStatus.CUTOVER,
      appCluster: SRC,
      bridgeState: { ...active },
    });
    mig.fullMigrationId = 'fm-1';
    mig.status = AppMigrationStatus.FAILED;

    await service.abort(mig.id, true);

    expect(calls[0]).toBe('rollback-bridge');
    expect(calls).toContain(`teardown:${DST}`);
    expect(mig.status).toBe(AppMigrationStatus.ABORTED);
  });

  it('never rolls back a bridge whose app already moved', async () => {
    const { service, mig, legs } = setup({
      status: AppMigrationStatus.CUTOVER,
      bridgeState: { ...active },
    });
    mig.fullMigrationId = 'fm-1';

    await expect(service.rollbackBridge(mig.id, true)).rejects.toThrow(
      /already/,
    );
    expect(legs.rollbackBridge).not.toHaveBeenCalled();
  });

  it('lets the orchestrator finish a leg whose bridge it opened', async () => {
    const { service, mig, queue } = setup({
      status: AppMigrationStatus.CUTOVER,
      appCluster: SRC,
      bridgeState: { ...active },
      liveJobs: [{ data: { migrationId: 'mig-1' } }],
    });
    mig.fullMigrationId = 'fm-1';

    await service.cutover(mig.id, true);

    expect(queue.add).toHaveBeenCalledWith('run-app-cutover', {
      migrationId: mig.id,
    });
  });

  it('leaves the legs of a full migration to their orchestrator at startup', async () => {
    const { service, mig, queue } = setup({
      status: AppMigrationStatus.CUTOVER,
    });
    mig.fullMigrationId = 'fm-1';

    await service.onModuleInit();

    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('a migration whose run died with the process', () => {
  it.each([AppMigrationStatus.PENDING, AppMigrationStatus.PROVISIONING])(
    'queues the run again at startup for a migration left %s with no job',
    async (status) => {
      const { service, queue, mig } = setup({ status });
      mig.updatedAt = new Date(9);

      await service.onModuleInit();

      expect(queue.add).toHaveBeenCalledWith(
        'run-app-migration',
        { migrationId: 'mig-1' },
        { jobId: 'resume-run:mig-1:9' },
      );
    },
  );

  it('resumes the run of a full migration leg too: its parent only waits for it', async () => {
    const { service, queue, mig } = setup({
      status: AppMigrationStatus.PROVISIONING,
    });
    mig.fullMigrationId = 'fm-1';

    await service.onModuleInit();

    expect(queue.add.mock.calls[0][0]).toBe('run-app-migration');
  });

  it('leaves a run Bull still holds', async () => {
    const { service, queue } = setup({
      status: AppMigrationStatus.PROVISIONING,
      liveJobs: [{ name: 'run-app-migration', data: { migrationId: 'mig-1' } }],
    });

    await service.onModuleInit();

    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('bridge-before-fence fixes after review (service)', () => {
  it('re-opens the bridge of a leg left in CUTOVER by a crash, when no job holds it', async () => {
    const { service, mig, queue } = setup({
      status: AppMigrationStatus.CUTOVER,
      appCluster: SRC,
      bridgeState: { mode: 'bridge', state: 'preparing', hosts: [] },
    });
    mig.fullMigrationId = 'fm-1';

    await service.openBridge(mig.id, true);

    expect(queue.add).toHaveBeenCalledWith('run-app-bridge-open', {
      migrationId: mig.id,
    });
  });

  it('leaves a bridge opening to the job that still holds the leg', async () => {
    const { service, mig, queue } = setup({
      status: AppMigrationStatus.CUTOVER,
      appCluster: SRC,
      bridgeState: { mode: 'bridge', state: 'preparing', hosts: [] },
      liveJobs: [
        { name: 'run-app-bridge-open', data: { migrationId: 'mig-1' } },
      ],
    });
    mig.fullMigrationId = 'fm-1';

    await service.openBridge(mig.id, true);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rolls a bridge back only once no job holds the leg', async () => {
    const jobs = [
      { name: 'run-app-bridge-open', data: { migrationId: 'mig-1' } },
    ];
    const { service, mig, queue, legs } = setup({
      status: AppMigrationStatus.CUTOVER,
      appCluster: SRC,
      bridgeState: { mode: 'bridge', state: 'active', hosts: [] },
    });
    mig.fullMigrationId = 'fm-1';
    queue.getJobs.mockImplementation(async () => jobs.splice(0, 1));

    await service.rollbackBridgeWhenIdle(mig.id, 5_000, 0);

    expect(queue.getJobs).toHaveBeenCalledTimes(2);
    expect(legs.rollbackBridge).toHaveBeenCalled();
  });

  it('gives up rolling back while a job keeps holding the leg', async () => {
    const { service, mig, legs } = setup({
      status: AppMigrationStatus.CUTOVER,
      appCluster: SRC,
      bridgeState: { mode: 'bridge', state: 'active', hosts: [] },
      liveJobs: [
        { name: 'run-app-bridge-open', data: { migrationId: 'mig-1' } },
      ],
    });
    mig.fullMigrationId = 'fm-1';

    await service.rollbackBridgeWhenIdle(mig.id, 0, 0);

    expect(legs.rollbackBridge).not.toHaveBeenCalled();
  });
});
