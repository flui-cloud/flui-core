import {
  DbSessionView,
  formatDuration,
  orderByBlocker,
  sessionTable,
  summaryOf,
  whoOf,
} from './db-sessions-view';

const s = (over: Partial<DbSessionView>): DbSessionView => ({
  pid: 1,
  backendStart: '2026-10-12T07:00:00.000Z',
  kind: 'client',
  via: 'direct',
  user: 'owner',
  database: 'app',
  applicationName: '',
  clientAddr: '10.42.0.15',
  clientApp: null,
  state: 'active',
  waitEventType: null,
  waitEvent: null,
  xactAgeMs: null,
  queryAgeMs: null,
  stateAgeMs: null,
  writing: false,
  query: 'SELECT ?',
  blockedBy: [],
  blocks: 0,
  actions: { cancel: true, terminate: true, reason: null },
  ...over,
});

describe('the sessions table', () => {
  it('puts blocked sessions under their blocker', () => {
    const ordered = orderByBlocker([
      s({ pid: 3, blockedBy: [2] }),
      s({ pid: 2, blockedBy: [1] }),
      s({ pid: 9 }),
      s({ pid: 1, blocks: 1 }),
    ]);
    expect(ordered.map((o) => [o.session.pid, o.depth])).toEqual([
      [9, 0],
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
  });

  it('shows every session once, even in a deadlock', () => {
    const ordered = orderByBlocker([
      s({ pid: 1, blockedBy: [2] }),
      s({ pid: 2, blockedBy: [1] }),
    ]);
    expect(ordered.map((o) => o.session.pid).sort()).toEqual([1, 2]);
  });

  it('falls back to the name the client gave itself, without the host the pooler appends', () => {
    expect(whoOf(s({ applicationName: 'holder' }))).toBe('holder');
    expect(
      whoOf(
        s({ via: 'pooler', applicationName: 'waiter - 10.42.0.140:47134' }),
      ),
    ).toBe('waiter (via pooler)');
  });

  it('names who is behind a session, and the pooler when it is between', () => {
    expect(whoOf(s({ clientApp: { id: 'a', name: 'talk-api' } }))).toBe(
      'talk-api',
    );
    expect(whoOf(s({ kind: 'pooler', via: 'pooler' }))).toBe(
      '10.42.0.15 (via pooler)',
    );
    expect(whoOf(s({ kind: 'local', via: 'socket', clientAddr: null }))).toBe(
      'inside the pod',
    );
  });

  it('reads durations the way a person says them', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(184_000)).toBe('3m 4s');
    expect(formatDuration(7_500_000)).toBe('2h 5m');
    expect(formatDuration(null)).toBe('');
  });

  it('renders a header and one line per session', () => {
    const lines = sessionTable([
      s({ pid: 1, blocks: 1, xactAgeMs: 61_000 }),
      s({ pid: 2, blockedBy: [1], waitEventType: 'Lock', waitEvent: 'tuple' }),
    ]);
    expect(lines[0]).toMatch(/^PID\s+WHO\s+STATE\s+FOR\s+WAITING ON\s+QUERY$/);
    expect(lines[1]).toContain('active (blocking 1)');
    expect(lines[1]).toContain('1m 1s');
    expect(lines[2]).toContain('└ 2');
    expect(lines[2]).toContain('pid 1');
  });

  it('sums up the database in one line', () => {
    expect(
      summaryOf({
        engine: 'postgres',
        capturedAt: '',
        truncated: false,
        maxConnections: 100,
        total: 14,
        counts: {
          active: 3,
          idle: 9,
          idleInTransaction: 2,
          waiting: 0,
          blocked: 1,
        },
        sessions: [],
        pooler: null,
      }),
    ).toBe(
      '14 connected of 100 · 3 running · 2 idle in transaction · 1 blocked',
    );
  });
});
