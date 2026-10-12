import {
  DbSessionsClient,
  performPooledClientClose,
} from './db-sessions-client';
import { DbPooledClientView, pooledClientTable } from './db-sessions-view';

const pooled = (
  over: Partial<DbPooledClientView> = {},
): DbPooledClientView => ({
  pod: 'pg-pooler-1',
  id: 17,
  addr: '10.42.0.15',
  clientApp: { id: 'a-1', name: 'talk-api' },
  user: 'app',
  database: 'app',
  state: 'active',
  waitMs: 0,
  serverPid: 4242,
  applicationName: '',
  connectTime: '2026-10-12 07:00:00 UTC',
  canClose: true,
  ...over,
});

function fake(clients: DbPooledClientView[] | null) {
  const closeClient = jest.fn(async () => ({
    clientId: 17,
    pod: 'pg-pooler-1',
    message: 'Pooled connection 17 closed.',
  }));
  jest.spyOn(DbSessionsClient, 'fromConfig').mockReturnValue({
    resolveDb: async () => ({ id: 'db-1', name: 'pg' }),
    list: async () => ({
      pooler: clients ? { clients, pools: [], mode: 'transaction' } : null,
    }),
    closeClient,
  } as unknown as DbSessionsClient);
  return closeClient;
}

const io = (answer: boolean) => ({
  log: jest.fn(),
  confirm: jest.fn(async () => answer),
});

describe('closing a pooled connection from the CLI', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends back the pod and connect time the list returned, after a yes', async () => {
    const closeClient = fake([pooled()]);
    const out = io(true);
    await expect(
      performPooledClientClose(out, { db: 'pg', clientId: 17, yes: false }),
    ).resolves.toBe('Pooled connection 17 closed.');
    expect(out.confirm).toHaveBeenCalled();
    expect(closeClient).toHaveBeenCalledWith(
      'db-1',
      expect.objectContaining({
        id: 17,
        pod: 'pg-pooler-1',
        connectTime: '2026-10-12 07:00:00 UTC',
      }),
    );
  });

  it('asks for the pod when the id exists on two pooler pods', async () => {
    const closeClient = fake([pooled(), pooled({ pod: 'pg-pooler-2' })]);
    await expect(
      performPooledClientClose(io(true), { db: 'pg', clientId: 17, yes: true }),
    ).rejects.toThrow(/--pod/);
    await performPooledClientClose(io(true), {
      db: 'pg',
      clientId: 17,
      pod: 'pg-pooler-2',
      yes: true,
    });
    expect(closeClient).toHaveBeenCalledWith(
      'db-1',
      expect.objectContaining({ pod: 'pg-pooler-2' }),
    );
  });

  it('says so when the database has no pooler', async () => {
    fake(null);
    await expect(
      performPooledClientClose(io(true), { db: 'pg', clientId: 17, yes: true }),
    ).rejects.toThrow(/no connection pooler/);
  });

  it('does nothing when the person says no', async () => {
    const closeClient = fake([pooled()]);
    await expect(
      performPooledClientClose(io(false), {
        db: 'pg',
        clientId: 17,
        yes: false,
      }),
    ).resolves.toBeNull();
    expect(closeClient).not.toHaveBeenCalled();
  });

  it('lists pooled clients with the session each one holds', () => {
    const [head, row] = pooledClientTable([pooled()]);
    expect(head).toMatch(/^CLIENT\s+WHO\s+STATE\s+WAITING\s+SESSION\s+POD$/);
    expect(row).toContain('talk-api');
    expect(row).toContain('pid 4242');
  });
});
