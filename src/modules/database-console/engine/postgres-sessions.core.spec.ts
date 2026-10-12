import {
  PgActivityRow,
  SESSION_ROW_LIMIT,
  parseSnapshot,
  sessionActionSql,
  sessionsListSql,
  toIsoMillis,
  toSessionDtos,
} from './postgres-sessions.core';

const row = (over: Partial<PgActivityRow> = {}): PgActivityRow => ({
  pid: 100,
  backend_start: '2026-10-12T07:00:00.123+00:00',
  backend_type: 'client backend',
  state: 'active',
  wait_event_type: null,
  wait_event: null,
  usename: 'app',
  datname: 'app',
  application_name: 'talk-api',
  client_addr: '10.42.0.15',
  writing: false,
  query: "UPDATE accounts SET balance = 10 WHERE owner = 'bob'",
  blocked_by: [],
  xact_age_ms: 1200,
  query_age_ms: 900,
  state_age_ms: 900,
  ...over,
});

const ctx = {
  poolerAddrs: new Set(['10.42.0.30']),
  appByAddr: new Map([['10.42.0.15', { id: 'app-1', name: 'talk-api' }]]),
};

describe('a session read from pg_stat_activity', () => {
  it('names the application behind a direct client and masks its statement', () => {
    const [s] = toSessionDtos([row()], ctx);
    expect(s).toMatchObject({
      kind: 'client',
      via: 'direct',
      clientApp: { id: 'app-1', name: 'talk-api' },
      query: 'UPDATE accounts SET balance = ? WHERE owner = ?',
      backendStart: '2026-10-12T07:00:00.123Z',
      actions: { cancel: true, terminate: true, reason: null },
    });
  });

  it('never offers to close a replication session', () => {
    const [s] = toSessionDtos(
      [row({ backend_type: 'walsender', client_addr: '10.99.0.2' })],
      ctx,
    );
    expect(s.kind).toBe('replication');
    expect(s.actions.cancel).toBe(false);
    expect(s.actions.terminate).toBe(false);
    expect(s.actions.reason).toMatch(/replication/);
  });

  it('never offers to close a session opened inside the pod', () => {
    const [s] = toSessionDtos([row({ client_addr: null })], ctx);
    expect(s).toMatchObject({ kind: 'local', via: 'socket' });
    expect(s.actions.terminate).toBe(false);
    expect(s.actions.reason).toBeTruthy();
  });

  it('reads a session from a pooler pod as the pooler', () => {
    const [s] = toSessionDtos([row({ client_addr: '10.42.0.30' })], ctx);
    expect(s).toMatchObject({ kind: 'pooler', via: 'pooler', clientApp: null });
  });

  it('offers no cancel when nothing runs, but still offers to close', () => {
    const [s] = toSessionDtos([row({ state: 'idle in transaction' })], ctx);
    expect(s.actions).toEqual({
      cancel: false,
      terminate: true,
      reason: 'No statement is running to cancel.',
    });
  });

  it('counts how many sessions each blocker holds up', () => {
    const sessions = toSessionDtos(
      [
        row({ pid: 1, state: 'idle in transaction' }),
        row({ pid: 2, blocked_by: [1] }),
        row({ pid: 3, blocked_by: [1, 2] }),
      ],
      ctx,
    );
    expect(sessions.map((s) => [s.pid, s.blocks])).toEqual([
      [1, 2],
      [2, 1],
      [3, 0],
    ]);
  });
});

describe('naming a session to act on it', () => {
  it('compares the start time to the millisecond, as the list returns it', () => {
    const sql = sessionActionSql('terminate', 4242, '2026-10-12T07:00:00.123Z');
    expect(sql).toContain(
      "date_trunc('milliseconds', backend_start) = date_trunc('milliseconds', :'started'::timestamptz)",
    );
    expect(sql).toContain('pg_terminate_backend(pid)');
    expect(sql).toContain("backend_type = 'client backend'");
    expect(sql).toContain('client_addr IS NOT NULL');
  });

  it('returns start times truncated to the millisecond in the list', () => {
    expect(sessionsListSql(false)).toContain(
      "date_trunc('milliseconds', a.backend_start) AS backend_start",
    );
    expect(toIsoMillis('2026-10-12T09:00:00.123+02:00')).toBe(
      '2026-10-12T07:00:00.123Z',
    );
  });

  it('binds the values as psql variables and refuses anything else', () => {
    expect(sessionActionSql('cancel', 7, '2026-10-12T07:00:00Z')).toMatch(
      /^\\set pid 7\n\\set started '2026-10-12T07:00:00Z'\nSELECT pg_cancel_backend/,
    );
    expect(() =>
      sessionActionSql('cancel', 7, "2026-10-12'; DROP TABLE x; --"),
    ).toThrow();
    expect(() =>
      sessionActionSql('cancel', -1, '2026-10-12T07:00:00Z'),
    ).toThrow();
    expect(() =>
      sessionActionSql('cancel', 1.5, '2026-10-12T07:00:00Z'),
    ).toThrow();
  });
});

describe('the list query', () => {
  it('keeps idle blockers when idle sessions are left out', () => {
    const sql = sessionsListSql(false);
    expect(sql).toContain(
      "a.state IS DISTINCT FROM 'idle' OR a.pid IN (SELECT pid FROM blockers)",
    );
    expect(sessionsListSql(true)).not.toContain('FROM blockers)\n');
    expect(sql).toContain(`LIMIT ${SESSION_ROW_LIMIT + 1}`);
    expect(sql).toContain('pg_blocking_pids(a.pid)');
  });

  it('parses the single value psql prints', () => {
    const snap = parseSnapshot(
      '{"rows": [], "counts": {"idle": 0, "total": 0, "active": 0, "blocked": 0, "waiting": 0, "idle_in_transaction": 0}, "truncated": false, "captured_at": "2026-10-12T07:00:00.5+00:00", "max_connections": 100}\n',
    );
    expect(snap.max_connections).toBe(100);
    expect(() => parseSnapshot('')).toThrow();
  });
});
