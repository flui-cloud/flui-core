jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { RunDbRestoreProcessor } from './run-db-restore.processor';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';

const SOURCE = 'eef3d3f8-0000-4000-8000-000000000001';
const BASE_AT = new Date('2026-09-26T21:18:07Z');
const LAST_ARCHIVED = '2026-09-26T21:22:36.000Z';

interface Scenario {
  engine: 'postgres' | 'mariadb';
  recoveryTargetTime?: Date;
  artifactIsNewest?: boolean;
  liveInfo?: boolean;
  installEnds?: CatalogInstallStatus;
  secondInstallEnds?: CatalogInstallStatus;
  endedBeforeTarget?: boolean;
}

function run(s: Scenario) {
  const artifact = {
    id: 'art-1',
    engine: s.engine,
    engineClass: 'database',
    engineRef: '20260926-211800F',
    createdAt: BASE_AT,
    manifestSummary: { applicationId: SOURCE },
    locations: [{ role: 'primary', destinationId: 'dest-1' }],
  };
  const buildRestoreEnv = jest.fn().mockReturnValue({});
  const engine = {
    engine: s.engine,
    catalogSlug: s.engine === 'postgres' ? 'postgresql' : 'mariadb',
    restoreEnvPrefix: s.engine === 'postgres' ? 'FLUI_PG_' : 'FLUI_MARIADB_',
    replaysToEndWithoutTarget: s.engine === 'postgres',
    info: jest.fn(async () => {
      if (s.liveInfo === false) throw new Error('source pod gone');
      return {
        latestLabel: artifact.engineRef,
        oldestRecoverable: BASE_AT.toISOString(),
        newestRecoverable: LAST_ARCHIVED,
        backupCount: 1,
      };
    }),
    buildRestoreEnv,
    identityEnv: jest.fn().mockReturnValue({}),
    endedBeforeTarget: jest.fn().mockResolvedValue(!!s.endedBeforeTarget),
  };
  const install = {
    id: 'inst-1',
    status: s.installEnds ?? CatalogInstallStatus.RUNNING,
    applicationIds: ['new-app'],
  };
  const second = {
    id: 'inst-2',
    status: s.secondInstallEnds ?? CatalogInstallStatus.RUNNING,
    applicationIds: ['new-app-2'],
  };
  const installer = {
    install: jest
      .fn()
      .mockResolvedValueOnce({ install })
      .mockResolvedValueOnce({ install: second }),
    uninstall: jest.fn().mockResolvedValue({}),
  };
  const restoreRepo = {
    findById: jest.fn().mockResolvedValue({
      id: 'rj-1',
      artifactId: 'art-1',
      userId: 'u1',
      sourceDestinationId: 'dest-1',
      recoveryTargetTime: s.recoveryTargetTime ?? null,
      targetSelector: { newInstall: { name: 'pg-restored', clusterId: 'c1' } },
    }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const processor = new RunDbRestoreProcessor(
    { update: jest.fn() } as never,
    { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() } as never,
    {
      findOne: jest.fn(async ({ where }: any) =>
        where.id === 'inst-2' ? second : install,
      ),
      save: jest.fn(),
    } as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    restoreRepo as never,
    {
      findArtifact: jest.fn().mockResolvedValue(artifact),
      findLatestDbArtifactForApp: jest
        .fn()
        .mockResolvedValue(
          s.artifactIsNewest === false ? { id: 'art-2' } : artifact,
        ),
    } as never,
    { findById: jest.fn().mockResolvedValue({ id: 'dest-1' }) } as never,
    { forEngine: jest.fn().mockReturnValue(engine) } as never,
    {
      findPublishedBySlug: jest.fn().mockResolvedValue({
        manifest: {
          spec: { env: [{ name: `${engine.restoreEnvPrefix}RESTORE` }] },
        },
      }),
    } as never,
    installer as never,
  );
  const done = processor.handle({
    data: { restoreJobId: 'rj-1', operationId: 'op-1' },
  } as never);
  const envArgs = (call = 0) => {
    const [, , target, set] = buildRestoreEnv.mock.calls[call];
    return { target, set };
  };
  return { done, envArgs, installer, restoreRepo };
}

describe('RunDbRestoreProcessor — which data a restore brings back', () => {
  it('postgres, no time, newest backup: replays the whole archive instead of stopping at the base', async () => {
    const r = run({ engine: 'postgres' });
    await r.done;
    expect(r.envArgs()).toEqual({ target: undefined, set: undefined });
  });

  it('mariadb, no time, newest backup: replays every archived log instead of the base alone', async () => {
    const before = Date.now();
    const r = run({ engine: 'mariadb' });
    await r.done;
    const { target, set } = r.envArgs();
    expect(set).toBeUndefined();
    expect((target as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('no time, an older backup chosen on purpose: that backup as it stood', async () => {
    const r = run({ engine: 'postgres', artifactIsNewest: false });
    await r.done;
    expect(r.envArgs()).toEqual({ target: undefined, set: '20260926-211800F' });
  });

  it('postgres, a time after everything archived: recovers to the end rather than failing', async () => {
    const r = run({
      engine: 'postgres',
      recoveryTargetTime: new Date('2026-09-26T21:23:30Z'),
    });
    await r.done;
    expect(r.envArgs()).toEqual({ target: undefined, set: undefined });
  });

  it('a time between two writes stays a point-in-time recovery', async () => {
    const at = new Date('2026-09-26T21:18:20Z');
    const r = run({ engine: 'postgres', recoveryTargetTime: at });
    await r.done;
    expect(r.envArgs()).toEqual({ target: at, set: undefined });
  });

  it('removes the install it created when the restore fails', async () => {
    const r = run({
      engine: 'postgres',
      recoveryTargetTime: new Date('2026-09-26T21:18:20Z'),
      installEnds: CatalogInstallStatus.FAILED,
    });
    await expect(r.done).rejects.toThrow(/removed/);
    expect(r.installer.uninstall).toHaveBeenCalledWith('inst-1', 'u1');
  });

  it('recovers everything archived when Postgres says nothing came after the moment', async () => {
    const r = run({
      engine: 'postgres',
      recoveryTargetTime: new Date('2026-09-26T21:22:30Z'),
      installEnds: CatalogInstallStatus.FAILED,
      endedBeforeTarget: true,
    });
    await r.done;
    expect(r.installer.uninstall).toHaveBeenCalledWith('inst-1', 'u1');
    expect(r.installer.install).toHaveBeenCalledTimes(2);
    expect(r.envArgs(1)).toEqual({ target: undefined, set: undefined });
  });
});
