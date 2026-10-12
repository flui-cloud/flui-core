import { DbSessionsClient, performSessionAction } from './db-sessions-client';
import { DbSessionView } from './db-sessions-view';

const session = (over: Partial<DbSessionView> = {}): DbSessionView => ({
  pid: 42,
  backendStart: '2026-10-12T07:00:00.123Z',
  kind: 'client',
  via: 'direct',
  user: 'owner',
  database: 'app',
  applicationName: '',
  clientAddr: '10.42.0.15',
  clientApp: { id: 'a-1', name: 'talk-api' },
  state: 'active',
  waitEventType: null,
  waitEvent: null,
  xactAgeMs: 1000,
  queryAgeMs: 1000,
  stateAgeMs: 1000,
  writing: false,
  query: 'SELECT ?',
  blockedBy: [],
  blocks: 0,
  actions: { cancel: true, terminate: true, reason: null },
  ...over,
});

function fake(found: DbSessionView | null) {
  const act = jest.fn(async () => ({
    pid: 42,
    action: 'terminate' as const,
    message: 'Session 42 closed.',
  }));
  jest.spyOn(DbSessionsClient, 'fromConfig').mockReturnValue({
    resolveDb: async () => ({ id: 'db-1', name: 'pg' }),
    find: async () => found,
    act,
  } as unknown as DbSessionsClient);
  return act;
}

const io = (answer: boolean) => ({
  log: jest.fn(),
  confirm: jest.fn(async () => answer),
});

describe('ending a session from the CLI', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends back the start time the list returned, after the person says yes', async () => {
    const act = fake(session());
    const out = io(true);
    await expect(
      performSessionAction(out, 'terminate', { db: 'pg', pid: 42, yes: false }),
    ).resolves.toBe('Session 42 closed.');
    expect(out.confirm).toHaveBeenCalled();
    expect(act).toHaveBeenCalledWith(
      'db-1',
      expect.objectContaining({
        pid: 42,
        backendStart: '2026-10-12T07:00:00.123Z',
      }),
      'terminate',
    );
  });

  it('does nothing when the person says no', async () => {
    const act = fake(session());
    await expect(
      performSessionAction(io(false), 'cancel', {
        db: 'pg',
        pid: 42,
        yes: false,
      }),
    ).resolves.toBeNull();
    expect(act).not.toHaveBeenCalled();
  });

  it('does not ask with --yes', async () => {
    fake(session());
    const out = io(false);
    await performSessionAction(out, 'cancel', { db: 'pg', pid: 42, yes: true });
    expect(out.confirm).not.toHaveBeenCalled();
  });

  it('repeats the API reason when the action is not offered', async () => {
    const act = fake(
      session({
        kind: 'replication',
        actions: {
          cancel: false,
          terminate: false,
          reason: 'A replica reads it.',
        },
      }),
    );
    await expect(
      performSessionAction(io(true), 'terminate', {
        db: 'pg',
        pid: 42,
        yes: true,
      }),
    ).rejects.toThrow('A replica reads it.');
    expect(act).not.toHaveBeenCalled();
  });

  it('says the session ended when it is gone', async () => {
    fake(null);
    await expect(
      performSessionAction(io(true), 'cancel', {
        db: 'pg',
        pid: 42,
        yes: true,
      }),
    ).rejects.toThrow(/may have ended/);
  });
});
