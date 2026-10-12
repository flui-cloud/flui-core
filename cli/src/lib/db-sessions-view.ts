export interface DbSessionView {
  pid: number;
  backendStart: string;
  kind: 'client' | 'pooler' | 'local' | 'replication' | 'background';
  via: 'pooler' | 'direct' | 'socket';
  user: string;
  database: string;
  applicationName: string;
  clientAddr: string | null;
  clientApp: { id: string; name: string } | null;
  state: string;
  waitEventType: string | null;
  waitEvent: string | null;
  xactAgeMs: number | null;
  queryAgeMs: number | null;
  stateAgeMs: number | null;
  writing: boolean;
  query: string;
  blockedBy: number[];
  blocks: number;
  actions: { cancel: boolean; terminate: boolean; reason: string | null };
}

export interface DbPoolerView {
  mode: string;
  paused: boolean;
  upstream: string;
  pools: Array<{
    pod: string;
    database: string;
    user: string;
    clientsActive: number;
    clientsWaiting: number;
    serversActive: number;
    serversIdle: number;
    maxWaitMs: number;
  }>;
  clients: DbPooledClientView[];
  reason: string | null;
}

export interface DbPooledClientView {
  pod: string;
  id: number;
  addr: string;
  clientApp: { id: string; name: string } | null;
  user: string;
  database: string;
  state: string;
  waitMs: number;
  serverPid: number | null;
  applicationName: string;
  connectTime: string;
  canClose: boolean;
}

export interface DbSessionsView {
  engine: string;
  capturedAt: string;
  truncated: boolean;
  maxConnections: number;
  total: number;
  counts: {
    active: number;
    idle: number;
    idleInTransaction: number;
    waiting: number;
    blocked: number;
  };
  sessions: DbSessionView[];
  pooler: DbPoolerView | null;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** The name a client gave itself; the pooler appends " - <host>:<port>". */
function declaredName(
  applicationName: string | null | undefined,
): string | null {
  const name = (applicationName ?? '').replace(/ - [^ ]+:\d+$/, '').trim();
  return name || null;
}

export function whoOf(s: DbSessionView): string {
  if (s.kind === 'replication') return 'replication';
  if (s.kind === 'local') return 'inside the pod';
  const base =
    s.clientApp?.name ?? declaredName(s.applicationName) ?? s.clientAddr ?? '?';
  return s.via === 'pooler' ? `${base} (via pooler)` : base;
}

export function waitingOnOf(s: DbSessionView): string {
  if (s.blockedBy.length) return `pid ${s.blockedBy.join(', ')}`;
  if (s.waitEventType && !['Client', 'Activity'].includes(s.waitEventType)) {
    return `${s.waitEventType}:${s.waitEvent ?? ''}`;
  }
  return '';
}

export function summaryOf(v: DbSessionsView): string {
  const parts = [
    `${v.total} connected of ${v.maxConnections}`,
    `${v.counts.active} running`,
    `${v.counts.idleInTransaction} idle in transaction`,
    `${v.counts.blocked} blocked`,
  ];
  if (v.pooler) {
    const waiting = v.pooler.pools.reduce((n, p) => n + p.clientsWaiting, 0);
    parts.push(`${waiting} waiting in the pooler`);
  }
  return parts.join(' · ');
}

/** Blocked sessions sit under the session they wait for, one level per hop. */
export function orderByBlocker(
  sessions: DbSessionView[],
): Array<{ session: DbSessionView; depth: number }> {
  const byPid = new Map(sessions.map((s) => [s.pid, s]));
  const children = new Map<number, DbSessionView[]>();
  const roots: DbSessionView[] = [];
  for (const s of sessions) {
    const parent = s.blockedBy.find((p) => byPid.has(p) && p !== s.pid);
    if (parent === undefined) {
      roots.push(s);
    } else {
      children.set(parent, [...(children.get(parent) ?? []), s]);
    }
  }
  const out: Array<{ session: DbSessionView; depth: number }> = [];
  const seen = new Set<number>();
  const visit = (s: DbSessionView, depth: number) => {
    if (seen.has(s.pid)) return;
    seen.add(s.pid);
    out.push({ session: s, depth });
    for (const c of children.get(s.pid) ?? []) visit(c, depth + 1);
  };
  roots.forEach((r) => visit(r, 0));
  for (const s of sessions) visit(s, 0);
  return out;
}

const COLUMNS = ['PID', 'WHO', 'STATE', 'FOR', 'WAITING ON', 'QUERY'];
const QUERY_WIDTH = 60;

export function sessionTable(sessions: DbSessionView[]): string[] {
  const rows = orderByBlocker(sessions).map(({ session: s, depth }) => [
    `${'  '.repeat(depth)}${depth ? '└ ' : ''}${s.pid}`,
    whoOf(s),
    s.blocks ? `${s.state} (blocking ${s.blocks})` : s.state,
    formatDuration(s.xactAgeMs ?? s.stateAgeMs),
    waitingOnOf(s),
    s.query.length > QUERY_WIDTH
      ? `${s.query.slice(0, QUERY_WIDTH - 1)}…`
      : s.query,
  ]);
  return alignedTable(COLUMNS, rows);
}

function alignedTable(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)];
}

export function sessionDescription(s: DbSessionView): string[] {
  const appName = s.applicationName ? ` · ${s.applicationName}` : '';
  return [
    `pid ${s.pid} · ${whoOf(s)} · ${s.state}`,
    `user ${s.user} · database ${s.database}${appName}`,
    s.query ? `query ${s.query}` : 'no statement',
  ];
}

export function pooledClientTable(clients: DbPooledClientView[]): string[] {
  const head = ['CLIENT', 'WHO', 'STATE', 'WAITING', 'SESSION', 'POD'];
  const rows = clients.map((c) => [
    String(c.id),
    c.clientApp?.name ?? c.addr,
    c.state,
    c.waitMs ? formatDuration(c.waitMs) : '',
    c.serverPid ? `pid ${c.serverPid}` : '',
    c.pod,
  ]);
  return alignedTable(head, rows);
}

export function pooledClientDescription(c: DbPooledClientView): string[] {
  return [
    `client ${c.id} on ${c.pod} · ${c.clientApp?.name ?? c.addr} · ${c.state}`,
    `user ${c.user} · database ${c.database} · connected ${c.connectTime}`,
    c.serverPid
      ? `holds database session ${c.serverPid}`
      : 'holds no database session',
  ];
}
