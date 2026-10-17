jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));
jest.mock('../../common/leadership/advisory-lock', () =>
  jest.requireActual('../../common/leadership/testing/fake-advisory-locks'),
);

import { FullMigrationProcessor } from './full-migration.processor';
import {
  holdLock,
  resetFakeLocks,
} from '../../common/leadership/testing/fake-advisory-locks';
import {
  FullCutoverMode,
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import { DbReplicationKind } from '../../db-lifecycle/enums/db-replication-status.enum';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';

function setup(
  fmOver: Record<string, any>,
  children: { db?: any; app?: any } = {},
) {
  const row: any = {
    id: 'fm-1',
    userId: 'u1',
    appId: 'app-1',
    dbAppId: 'db-1',
    targetClusterId: 'dst',
    stagingMode: FullStagingMode.SCALED_DOWN,
    cutoverMode: FullCutoverMode.MANUAL,
    status: FullMigrationStatus.PENDING,
    ...fmOver,
  };
  const db = children.db;
  const app = children.app;
  const fmRepo = {
    manager: {},
    findOne: jest.fn(async () => ({ ...row })),
    save: jest.fn(async (e: any) => Object.assign(row, e)),
  };
  const dbMigRepo = {
    findOne: jest.fn(async ({ where }: any) => {
      if (!db) return null;
      if (where.id && where.id !== db.id) return null;
      if (where.fullMigrationId && where.fullMigrationId !== row.id)
        return null;
      return db;
    }),
  };
  const appMigRepo = {
    findOne: jest.fn(async ({ where }: any) => {
      if (!app) return null;
      if (where.id && where.id !== app.id) return null;
      if (where.fullMigrationId && where.fullMigrationId !== row.id)
        return null;
      return app;
    }),
  };
  const dbMig = {
    create: jest.fn(async () => ({
      id: 'db-new',
      kind: DbReplicationKind.PHYSICAL,
    })),
    abort: jest.fn(),
  };
  const appMig = {
    create: jest.fn(async () => ({ id: 'app-new' })),
    abort: jest.fn(),
  };
  const ops = {
    load: jest.fn(async () => ({ ...row })),
    setState: jest.fn(async (fm: any, status: string) => {
      fm.status = status;
      Object.assign(row, fm);
    }),
    setStep: jest.fn(),
    waitDb: jest.fn(async () => undefined),
    waitApp: jest.fn(async () => undefined),
    fail: jest.fn(async (fm: any, _e: any, status: string) => {
      row.status = status;
    }),
  };
  const proc = new FullMigrationProcessor(
    fmRepo as any,
    dbMigRepo as any,
    appMigRepo as any,
    { findById: jest.fn(async (id: string) => ({ id })) } as any,
    dbMig as any,
    { fence: jest.fn(), unfence: jest.fn() } as any,
    appMig as any,
    {} as any,
    { computeRewirePlan: jest.fn(() => ({ env: [] })) } as any,
    ops as any,
  );
  return { proc, row, dbMig, appMig, ops };
}

const job = { data: { migrationId: 'fm-1' } } as any;

describe('FullMigrationProcessor run, delivered again', () => {
  beforeEach(() => resetFakeLocks());

  it('leaves a migration another copy of the API is driving alone and tries again later', async () => {
    const { proc, dbMig, appMig, ops } = setup({});
    const queue = { add: jest.fn(async () => undefined) };
    const release = holdLock('full-migration:fm-1');
    await proc.run({
      ...job,
      id: '3',
      name: 'run-full-migration',
      opts: {},
      queue,
    });
    release();
    expect(ops.load).not.toHaveBeenCalled();
    expect(dbMig.create).not.toHaveBeenCalled();
    expect(appMig.create).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'run-full-migration',
      { migrationId: 'fm-1', heldRetries: 1 },
      { delay: 60_000, jobId: expect.stringMatching(/^3:held:\d+$/) },
    );
  });

  it('re-attaches to its DB leg in DB_REPLICATING and carries on, never creating a second one', async () => {
    const { proc, row, dbMig, appMig, ops } = setup(
      { status: FullMigrationStatus.DB_REPLICATING, dbMigrationId: 'db-1' },
      {
        db: {
          id: 'db-1',
          kind: DbReplicationKind.PHYSICAL,
          status: DbMigrationStatus.SYNCED,
        },
      },
    );
    await proc.run(job);
    expect(dbMig.create).not.toHaveBeenCalled();
    expect(ops.waitDb).toHaveBeenCalledWith(
      'db-1',
      DbMigrationStatus.SYNCED,
      expect.any(Number),
    );
    expect(appMig.create).toHaveBeenCalledTimes(1);
    expect(row.status).toBe(FullMigrationStatus.READY);
  });

  it('finds a DB leg created just before the crash by its parent id', async () => {
    const { proc, row, dbMig } = setup(
      { status: FullMigrationStatus.DB_REPLICATING },
      {
        db: {
          id: 'db-1',
          kind: DbReplicationKind.PHYSICAL,
          status: DbMigrationStatus.REPLICATING,
        },
      },
    );
    await proc.run(job);
    expect(dbMig.create).not.toHaveBeenCalled();
    expect(row.dbMigrationId).toBe('db-1');
  });

  it('re-attaches to its app leg in APP_STAGING and waits for it', async () => {
    const { proc, row, dbMig, appMig, ops } = setup(
      {
        status: FullMigrationStatus.APP_STAGING,
        dbMigrationId: 'db-1',
        appMigrationId: 'am-1',
      },
      {
        db: { id: 'db-1', status: DbMigrationStatus.SYNCED },
        app: { id: 'am-1', status: AppMigrationStatus.PROVISIONING },
      },
    );
    await proc.run(job);
    expect(dbMig.create).not.toHaveBeenCalled();
    expect(appMig.create).not.toHaveBeenCalled();
    expect(ops.waitDb).not.toHaveBeenCalled();
    expect(ops.waitApp).toHaveBeenCalledWith(
      'am-1',
      AppMigrationStatus.READY,
      expect.any(Number),
    );
    expect(row.status).toBe(FullMigrationStatus.READY);
  });

  it('creates the app leg when the crash came before it existed', async () => {
    const { proc, row, appMig } = setup(
      { status: FullMigrationStatus.APP_STAGING, dbMigrationId: 'db-1' },
      { db: { id: 'db-1', status: DbMigrationStatus.SYNCED } },
    );
    await proc.run(job);
    expect(appMig.create).toHaveBeenCalledTimes(1);
    expect(row.appMigrationId).toBe('app-new');
  });

  it('starts from scratch only when PENDING', async () => {
    const { proc, dbMig, appMig } = setup({});
    await proc.run(job);
    expect(dbMig.create).toHaveBeenCalledTimes(1);
    expect(appMig.create).toHaveBeenCalledTimes(1);
  });

  it('does not drive a migration this process is already driving', async () => {
    const ctx = setup({});
    let release!: () => void;
    ctx.ops.waitDb.mockImplementationOnce(
      () => new Promise<void>((r) => (release = r)),
    );
    const first = ctx.proc.run(job);
    await new Promise((r) => setImmediate(r));
    const queue = { add: jest.fn(async () => undefined) };
    await ctx.proc.run({ ...job, id: '4', name: 'run', opts: {}, queue });
    expect(queue.add).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(ctx.dbMig.create).toHaveBeenCalledTimes(1);
    expect(ctx.appMig.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    FullMigrationStatus.CUTOVER,
    FullMigrationStatus.COMPLETED,
    FullMigrationStatus.ABORTED,
    FullMigrationStatus.FAILED,
  ])('leaves a migration in %s to its own job', async (status) => {
    const { proc, dbMig, appMig, ops } = setup({
      status,
      dbMigrationId: 'db-1',
      appMigrationId: 'am-1',
    });
    await proc.run(job);
    expect(dbMig.create).not.toHaveBeenCalled();
    expect(appMig.create).not.toHaveBeenCalled();
    expect(ops.waitDb).not.toHaveBeenCalled();
  });
});
