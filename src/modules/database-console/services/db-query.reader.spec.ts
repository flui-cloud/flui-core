jest.mock('@kubernetes/client-node', () => ({}));
import { ForbiddenException } from '@nestjs/common';
import { DbQueryService, READER_ROLE_NAME } from './db-query.service';
import { ResolvedDbConnection } from '../interfaces/db-connection';
import { ReaderRole, SqlEngineConnection } from '../engine/sql-engine';

const resolved: ResolvedDbConnection = {
  engine: 'postgres',
  role: 'owner',
  target: {
    clusterId: 'c',
    namespace: 'p-showcase',
    podLabelSelector: 'x',
    port: 5432,
  },
  credentials: { user: 'owner', password: 'owner-secret', database: 'demo' },
};

function serviceWith(
  opts: { ensures?: boolean; refuseSecondReader?: boolean } = {},
) {
  const sessions: Array<{ user?: string; password?: string }> = [];
  const provisioned: ReaderRole[] = [];
  let readerLogins = 0;
  const adapter = {
    engine: 'postgres',
    connect: jest.fn(async ({ credentials }) => {
      if (credentials.user === READER_ROLE_NAME) {
        readerLogins++;
        if (opts.refuseSecondReader && readerLogins === 2)
          throw Object.assign(new Error('auth'), { code: '28P01' });
      }
      sessions.push({ user: credentials.user, password: credentials.password });
      const conn: SqlEngineConnection = {
        query: jest.fn(async () => ({
          command: 'SELECT',
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          durationMs: 1,
        })),
        introspect: jest.fn(async () => ({
          engine: 'postgres' as const,
          schemas: [],
        })),
        close: jest.fn(async () => undefined),
        ...(opts.ensures === false
          ? {}
          : {
              ensureReaderRole: jest.fn(
                async (role: ReaderRole) => void provisioned.push(role),
              ),
            }),
      };
      return conn;
    }),
  };
  const service = new DbQueryService(
    { resolve: jest.fn(async () => resolved) } as never,
    {
      open: jest.fn(async () => ({
        localPort: 1,
        dispose: jest.fn(async () => undefined),
      })),
    } as never,
    { getKubeconfig: jest.fn(async () => 'kubeconfig') } as never,
    [adapter] as never,
    { emit: jest.fn() } as never,
  );
  return { service, sessions, provisioned };
}

const reader = {
  dbInstallId: 'db-1',
  fluiUserId: 'guest',
  access: 'reader' as const,
};
const run = (service: DbQueryService) =>
  service.runQuery(reader, 'SELECT 1', {
    readOnly: true,
    statementTimeoutMs: 5000,
    maxRows: 10,
  });

describe('the SQL console as a reader', () => {
  it('runs the statement as the reader role, never as the owner', async () => {
    const { service, sessions, provisioned } = serviceWith();
    await run(service);
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]).toMatchObject({
      name: READER_ROLE_NAME,
      database: 'demo',
    });
    expect(sessions.at(-1)).toEqual({
      user: READER_ROLE_NAME,
      password: provisioned[0].password,
    });
  });

  it('opens the owner session only once while the password is fresh', async () => {
    const { service, sessions } = serviceWith();
    await run(service);
    await run(service);
    expect(sessions.filter((s) => s.user === 'owner')).toHaveLength(1);
  });

  it('sets a new password when another copy of the API replaced it', async () => {
    const { service, provisioned, sessions } = serviceWith({
      refuseSecondReader: true,
    });
    await run(service);
    await run(service);
    expect(provisioned).toHaveLength(2);
    expect(sessions.at(-1)).toEqual({
      user: READER_ROLE_NAME,
      password: provisioned[1].password,
    });
  });

  it('refuses an engine that cannot make a reader', async () => {
    const { service, sessions } = serviceWith({ ensures: false });
    await expect(run(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessions.every((s) => s.user === 'owner')).toBe(true);
  });

  it('leaves the owner path as it was', async () => {
    const { service, sessions, provisioned } = serviceWith();
    await service.runQuery(
      { dbInstallId: 'db-1', fluiUserId: 'u' },
      'SELECT 1',
      {
        readOnly: true,
        statementTimeoutMs: 30000,
        maxRows: 10,
      },
    );
    expect(provisioned).toHaveLength(0);
    expect(sessions).toEqual([{ user: 'owner', password: 'owner-secret' }]);
  });
});
