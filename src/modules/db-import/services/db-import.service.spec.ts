jest.mock('../../db-lifecycle/services/db-pod-exec.service', () => ({
  DbPodExecService: class {},
}));
jest.mock('./pg-import.runner', () => ({ PgImportRunner: class {} }));
jest.mock('./mariadb-import.runner', () => ({ MariadbImportRunner: class {} }));
jest.mock('../../applications/repositories/applications.repository', () => ({
  ApplicationsRepository: class {},
}));
jest.mock('../../applications/services/application-access.service', () => ({
  ApplicationAccessService: class {},
}));

import {
  DbImportService,
  describeSourceError,
  engineOf,
} from './db-import.service';
import { DbImportEntity, DbImportStatus } from '../entities/db-import.entity';

const source = {
  host: 'db.example.com',
  port: 5432,
  database: 'shop',
  user: 'replicator',
  sslmode: 'require' as const,
};
const user = { userId: 'u1' } as never;

function runnerMock() {
  return {
    copy: jest.fn(async (): Promise<string | null> => null),
    progress: jest.fn(async () => ({ streaming: true, lagSeconds: 3 })),
    caughtUp: jest.fn(async () => true),
    finish: jest.fn(async (): Promise<string[]> => []),
    cleanUp: jest.fn(async (): Promise<string[]> => []),
  };
}

function build(
  row?: Partial<DbImportEntity>,
  env = [{ name: 'POSTGRES_USER', value: 'app' }],
) {
  let stored: DbImportEntity | null = row
    ? ({
        id: 'imp-1',
        targetApplicationId: 'app-1',
        engine: 'postgres',
        source,
        sourcePasswordEncrypted: 'enc:secret',
        objectName: 'flui_import_imp1',
        tablesWithoutKey: [],
        tablesTotal: null,
        tablesCopied: null,
        lagBytes: null,
        detail: null,
        endedAt: null,
        createdAt: new Date(),
        ...row,
      } as DbImportEntity)
    : null;
  const imports = {
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => {
      stored = { id: 'imp-1', createdAt: new Date(), ...stored, ...v };
      return stored;
    }),
    findOne: jest.fn(async () => stored),
    findOneByOrFail: jest.fn(async () => stored),
  };
  const app = { id: 'app-1', env };
  const applications = { findById: jest.fn(async () => app) };
  const access = { assertCan: jest.fn(async () => undefined) };
  const exec = {
    envValue: (a: typeof app, n: string) =>
      a.env.find((e) => e.name === n)?.value,
    resolve: jest.fn(async () => ({ slug: 'db-1', pgDb: 'app' })),
  };
  const encryption = {
    encrypt: (v: string) => `enc:${v}`,
    decrypt: (v: string) => v.replace(/^enc:/, ''),
  };
  const queue = { add: jest.fn(async () => undefined) };
  const pg = runnerMock();
  const mariadb = runnerMock();
  const service = new DbImportService(
    imports as never,
    applications as never,
    access as never,
    exec as never,
    encryption as never,
    queue as never,
    pg as never,
    mariadb as never,
  );
  return { service, queue, pg, mariadb, current: () => stored! };
}

describe('DbImportService', () => {
  it('tells the two catalog engines apart, and refuses anything else', async () => {
    expect(
      engineOf({ env: [{ name: 'POSTGRES_USER', value: 'x' }] } as never),
    ).toBe('postgres');
    expect(
      engineOf({
        env: [{ name: 'MARIADB_ROOT_PASSWORD', value: 'x' }],
      } as never),
    ).toBe('mariadb');
    const { service } = build(undefined, [{ name: 'PORT', value: '80' }]);
    await expect(
      service.start(user, 'app-1', { source, password: 'p' }),
    ).rejects.toThrow(/PostgreSQL or MariaDB/);
  });

  it('refuses a source that could break out of a command, and a password with a line break', async () => {
    const { service } = build();
    await expect(
      service.start(user, 'app-1', {
        source: { ...source, host: "x'; reboot" },
        password: 'a\nb',
      }),
    ).rejects.toThrow(/host must be .*password is required/);
  });

  it('refuses a second import into the same database', async () => {
    const { service } = build({ status: DbImportStatus.COPYING });
    await expect(
      service.start(user, 'app-1', { source, password: 'p' }),
    ).rejects.toThrow(/already running/);
  });

  it('keeps the password encrypted, records the engine and queues the copy', async () => {
    const { service, queue, current } = build(undefined, [
      { name: 'MARIADB_ROOT_PASSWORD', value: 'r' },
    ]);
    const view = await service.start(user, 'app-1', { source, password: 'p' });
    expect(current()).toMatchObject({
      engine: 'mariadb',
      sourcePasswordEncrypted: 'enc:p',
    });
    expect(view).not.toHaveProperty('sourcePasswordEncrypted');
    expect(queue.add).toHaveBeenCalledWith('copy', { importId: 'imp-1' });
  });

  it('hands the copy to the engine of the import', async () => {
    const { service, pg, mariadb, current } = build(
      { status: DbImportStatus.CHECKING, engine: 'mariadb' },
      [
        { name: 'MARIADB_ROOT_PASSWORD', value: 'r' },
        { name: 'MARIADB_DATABASE', value: 'shopdb' },
      ],
    );
    await service.runCopy('imp-1');
    expect(pg.copy).not.toHaveBeenCalled();
    expect(mariadb.copy).toHaveBeenCalledWith(
      expect.objectContaining({ targetDatabase: 'shopdb', password: 'secret' }),
    );
    expect(current().status).toBe(DbImportStatus.COPYING);
  });

  it('ends with the reason when the source is not ready, and drops the password', async () => {
    const { service, pg, current } = build({ status: DbImportStatus.CHECKING });
    pg.copy.mockResolvedValueOnce('wal_level on the source is "replica"');
    await service.runCopy('imp-1');
    expect(pg.cleanUp).not.toHaveBeenCalled();
    expect(current()).toMatchObject({
      status: DbImportStatus.FAILED,
      sourcePasswordEncrypted: null,
    });
  });

  it('undoes what it started when the copy breaks halfway', async () => {
    const { service, pg, current } = build({ status: DbImportStatus.CHECKING });
    pg.copy.mockRejectedValueOnce(
      new Error('could not connect to server: Connection refused'),
    );
    pg.cleanUp.mockResolvedValueOnce([
      'On the source, remove the publication by hand.',
    ]);
    await service.runCopy('imp-1');
    expect(pg.cleanUp).toHaveBeenCalled();
    expect(current().detail).toMatch(
      /did not answer from the cluster.*remove the publication/s,
    );
  });

  it('reads progress live and moves to streaming when every table is in', async () => {
    const { service, current } = build({ status: DbImportStatus.COPYING });
    const view = await service.view(user, 'app-1');
    expect(view).toMatchObject({
      status: DbImportStatus.STREAMING,
      lagSeconds: 3,
    });
    expect(current().status).toBe(DbImportStatus.STREAMING);
  });

  it('goes back to streaming, removing nothing, while writes keep arriving', async () => {
    const { service, pg, current } = build({
      status: DbImportStatus.CUTTING_OVER,
    });
    pg.caughtUp.mockResolvedValueOnce(false);
    await service.runCutover('imp-1');
    expect(pg.finish).not.toHaveBeenCalled();
    expect(current().status).toBe(DbImportStatus.STREAMING);
    expect(current().detail).toContain('Stop every write');
  });

  it('finishes once caught up and drops the password', async () => {
    const { service, pg, current } = build({
      status: DbImportStatus.CUTTING_OVER,
    });
    await service.runCutover('imp-1');
    expect(pg.finish).toHaveBeenCalled();
    expect(current()).toMatchObject({
      status: DbImportStatus.COMPLETED,
      sourcePasswordEncrypted: null,
    });
  });

  it('cancels by undoing, keeping what was copied', async () => {
    const { service, pg, current } = build({
      status: DbImportStatus.STREAMING,
    });
    await service.runAbort('imp-1');
    expect(pg.cleanUp).toHaveBeenCalled();
    expect(current()).toMatchObject({
      status: DbImportStatus.ABORTED,
      sourcePasswordEncrypted: null,
    });
  });

  it('never repeats a password in an error, whichever engine wrote it', () => {
    expect(
      describeSourceError(new Error('Connection refused password=hunter2')),
    ).toMatch(/password=\*\*\*/);
    expect(
      describeSourceError(new Error("near MASTER_PASSWORD = 'hunter2'")),
    ).not.toContain('hunter2');
  });
});
