jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { RunDbRestoreProcessor } from './run-db-restore.processor';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';

const SOURCE = 'eef3d3f8-0000-4000-8000-000000000001';

function run(sourceApp: unknown, engineOver: Record<string, string> = {}) {
  const calls: string[] = [];
  const artifact = {
    id: 'art-1',
    engine: 'postgres',
    engineClass: 'database',
    engineRef: '20260926-211800F',
    createdAt: new Date('2026-09-26T21:18:07Z'),
    manifestSummary: { applicationId: SOURCE },
    locations: [{ role: 'primary', destinationId: 'dest-1' }],
  };
  const engine = {
    engine: 'postgres',
    catalogSlug: 'postgresql',
    restoreEnvPrefix: 'FLUI_PG_',
    replaysToEndWithoutTarget: true,
    info: jest.fn(async () => ({
      latestLabel: artifact.engineRef,
      oldestRecoverable: artifact.createdAt.toISOString(),
      newestRecoverable: '2026-09-26T21:22:36.000Z',
      backupCount: 1,
    })),
    buildRestoreEnv: jest.fn().mockReturnValue({}),
    identityEnv: jest.fn().mockReturnValue({}),
    reconcileAfterRestore: jest.fn(async () => {
      calls.push('primary');
    }),
    ...engineOver,
  };
  const install = {
    id: 'inst-1',
    status: CatalogInstallStatus.RUNNING,
    applicationIds: ['new-app'],
  };
  const installer = { install: jest.fn().mockResolvedValue({ install }) };
  const poolers = {
    bringUp: jest.fn(async () => {
      calls.push('pooler');
      return { routed: true, reason: null };
    }),
  };
  const processor = new RunDbRestoreProcessor(
    { update: jest.fn() } as never,
    {
      findOne: jest.fn().mockResolvedValue(sourceApp),
      save: jest.fn(),
    } as never,
    { findOne: jest.fn().mockResolvedValue(install), save: jest.fn() } as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    {
      findById: jest.fn().mockResolvedValue({
        id: 'rj-1',
        artifactId: 'art-1',
        userId: 'u1',
        sourceDestinationId: 'dest-1',
        recoveryTargetTime: null,
        targetSelector: {
          newInstall: { name: 'pg-restored', clusterId: 'c1' },
        },
      }),
      update: jest.fn(),
    } as never,
    {
      findArtifact: jest.fn().mockResolvedValue(artifact),
      findLatestDbArtifactForApp: jest.fn().mockResolvedValue(artifact),
    } as never,
    { findById: jest.fn().mockResolvedValue({ id: 'dest-1' }) } as never,
    { forEngine: jest.fn().mockReturnValue(engine) } as never,
    {
      findPublishedBySlug: jest.fn().mockResolvedValue({
        manifest: { spec: { env: [{ name: 'FLUI_PG_RESTORE' }] } },
      }),
    } as never,
    installer as never,
    poolers as never,
  );
  const done = processor.handle({
    data: { restoreJobId: 'rj-1', operationId: 'op-1' },
  } as never);
  const options = () =>
    (
      installer.install.mock.calls[0] as unknown as [
        string,
        { options?: unknown },
      ]
    )[1].options;
  return { done, options, poolers, calls };
}

describe('a restored PostgreSQL and the pooler', () => {
  it('gets the pooler its source had, in the same mode', async () => {
    const r = run({
      id: SOURCE,
      env: [],
      pooler: { enabled: true, mode: 'session' },
    });
    await r.done;
    expect(r.options()).toEqual({ pooler: true, poolerSessionMode: true });
  });

  it('gets none when its source had none', async () => {
    const r = run({ id: SOURCE, env: [], pooler: null });
    await r.done;
    expect(r.options()).toEqual({ pooler: false, poolerSessionMode: false });
  });

  it('gets none when the source is gone', async () => {
    const r = run(null);
    await r.done;
    expect(r.options()).toEqual({ pooler: false, poolerSessionMode: false });
  });

  it('states no pooler options for an engine whose catalog app has none', async () => {
    const r = run(
      { id: SOURCE, env: [], pooler: { enabled: true, mode: 'session' } },
      { engine: 'mariadb', catalogSlug: 'mariadb' },
    );
    await r.done.catch(() => undefined);
    expect(r.options()).toBeUndefined();
  });

  it('sets the pooler role up once the restored database is a primary', async () => {
    const r = run({
      id: SOURCE,
      env: [],
      pooler: { enabled: true, mode: 'transaction' },
    });
    await r.done;
    expect(r.poolers.bringUp).toHaveBeenCalledWith('new-app');
    expect(r.calls).toEqual(['primary', 'pooler']);
  });
});
