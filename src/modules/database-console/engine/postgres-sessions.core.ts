import { maskSqlLiterals } from '../utils/mask-sql-literals';
import {
  BACKEND_START_PATTERN,
  DbSessionActionsDto,
  DbSessionAppRefDto,
  DbSessionCountsDto,
  DbSessionDto,
  DbSessionKind,
  DbSessionVia,
} from '../dto/db-sessions.dto';

export const SESSION_ROW_LIMIT = 500;
const QUERY_SOURCE_MAX = 8192;

export type SessionAction = 'cancel' | 'terminate';

export interface PgActivityRow {
  pid: number;
  backend_start: string;
  backend_type: string;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  usename: string | null;
  datname: string | null;
  application_name: string | null;
  client_addr: string | null;
  writing: boolean;
  query: string | null;
  blocked_by: number[] | null;
  xact_age_ms: number | null;
  query_age_ms: number | null;
  state_age_ms: number | null;
}

export interface PgActivitySnapshot {
  captured_at: string;
  max_connections: number;
  counts: {
    total: number;
    active: number;
    idle: number;
    idle_in_transaction: number;
    waiting: number;
    blocked: number;
  };
  truncated: boolean;
  rows: PgActivityRow[];
}

const ageMs = (column: string) =>
  `(extract(epoch from (clock_timestamp() - a.${column})) * 1000)::bigint`;

/**
 * One round trip on the local socket. Idle rows are left out unless asked for,
 * after counting, but an idle session that blocks somebody always stays: an
 * advisory lock is held by a session doing nothing.
 */
export function sessionsListSql(includeIdle: boolean): string {
  return `
WITH a AS (
  SELECT a.*, pg_blocking_pids(a.pid) AS blocked_by
  FROM pg_stat_activity a
  WHERE a.pid <> pg_backend_pid()
    AND a.backend_type IN ('client backend', 'walsender')
), blockers AS (
  SELECT DISTINCT unnest(blocked_by) AS pid FROM a
), shown AS (
  SELECT a.pid,
         date_trunc('milliseconds', a.backend_start) AS backend_start,
         a.backend_type, a.state, a.wait_event_type, a.wait_event,
         a.usename, a.datname, a.application_name,
         host(a.client_addr) AS client_addr,
         a.backend_xid IS NOT NULL AS writing,
         left(a.query, ${QUERY_SOURCE_MAX}) AS query,
         a.blocked_by,
         ${ageMs('xact_start')} AS xact_age_ms,
         ${ageMs('query_start')} AS query_age_ms,
         ${ageMs('state_change')} AS state_age_ms
  FROM a
  WHERE ${includeIdle ? 'true' : "a.state IS DISTINCT FROM 'idle' OR a.pid IN (SELECT pid FROM blockers)"}
  ORDER BY a.xact_start NULLS LAST, a.backend_start
  LIMIT ${SESSION_ROW_LIMIT + 1}
)
SELECT json_build_object(
  'captured_at', clock_timestamp(),
  'max_connections', current_setting('max_connections')::int,
  'counts', (SELECT json_build_object(
      'total', count(*),
      'active', count(*) FILTER (WHERE state = 'active'),
      'idle', count(*) FILTER (WHERE state = 'idle'),
      'idle_in_transaction', count(*) FILTER (WHERE state LIKE 'idle in transaction%'),
      'waiting', count(*) FILTER (WHERE state = 'active' AND wait_event_type IS NOT NULL AND wait_event_type NOT IN ('Client', 'Activity')),
      'blocked', count(*) FILTER (WHERE cardinality(blocked_by) > 0)) FROM a),
  'truncated', (SELECT count(*) > ${SESSION_ROW_LIMIT} FROM shown),
  'rows', coalesce((SELECT json_agg(s ORDER BY s.xact_age_ms DESC NULLS LAST, s.backend_start) FROM (SELECT * FROM shown LIMIT ${SESSION_ROW_LIMIT}) s), '[]'::json))::jsonb;
`;
}

const PG_FUNCTION: Record<SessionAction, string> = {
  cancel: 'pg_cancel_backend',
  terminate: 'pg_terminate_backend',
};

export function assertSessionIdentity(pid: number, backendStart: string): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    throw new Error(`Not a session id: ${pid}`);
  }
  if (!BACKEND_START_PATTERN.test(backendStart)) {
    throw new Error(`Not a session start time: ${backendStart}`);
  }
}

/**
 * The session is named by pid and start time, both compared to the
 * millisecond the list returned, so a pid the server reused is never hit. Only
 * a client backend reached over the network qualifies: replication and
 * sessions opened inside the pod are out of reach here whatever the caller asks.
 */
export function sessionActionSql(
  action: SessionAction,
  pid: number,
  backendStart: string,
): string {
  assertSessionIdentity(pid, backendStart);
  return [
    String.raw`\set pid ${pid}`,
    String.raw`\set started '${backendStart}'`,
    `SELECT ${PG_FUNCTION[action]}(pid) FROM pg_stat_activity` +
      ` WHERE pid = :'pid'::int` +
      ` AND date_trunc('milliseconds', backend_start) = date_trunc('milliseconds', :'started'::timestamptz)` +
      ` AND backend_type = 'client backend' AND client_addr IS NOT NULL;`,
    '',
  ].join('\n');
}

export function toIsoMillis(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export interface SessionContext {
  poolerAddrs: ReadonlySet<string>;
  appByAddr: ReadonlyMap<string, DbSessionAppRefDto>;
}

function kindOf(
  row: PgActivityRow,
  ctx: SessionContext,
): { kind: DbSessionKind; via: DbSessionVia } {
  if (row.backend_type === 'walsender') {
    return { kind: 'replication', via: row.client_addr ? 'direct' : 'socket' };
  }
  if (row.backend_type !== 'client backend') {
    return { kind: 'background', via: 'socket' };
  }
  if (!row.client_addr) return { kind: 'local', via: 'socket' };
  if (ctx.poolerAddrs.has(row.client_addr)) {
    return { kind: 'pooler', via: 'pooler' };
  }
  return { kind: 'client', via: 'direct' };
}

const REFUSED: Partial<Record<DbSessionKind, string>> = {
  replication:
    'A replica or a migration reads from this session; closing it would break replication.',
  local:
    'Opened from inside the database pod, by Flui or by somebody there: it is left alone.',
  background: 'A server process of the database itself.',
};

export function actionsFor(
  kind: DbSessionKind,
  state: string,
): DbSessionActionsDto {
  const refused = REFUSED[kind];
  if (refused) return { cancel: false, terminate: false, reason: refused };
  if (state !== 'active') {
    return {
      cancel: false,
      terminate: true,
      reason: 'No statement is running to cancel.',
    };
  }
  return { cancel: true, terminate: true, reason: null };
}

export function toSessionDtos(
  rows: PgActivityRow[],
  ctx: SessionContext,
): DbSessionDto[] {
  const blocks = new Map<number, number>();
  for (const row of rows) {
    for (const blocker of row.blocked_by ?? []) {
      blocks.set(blocker, (blocks.get(blocker) ?? 0) + 1);
    }
  }
  return rows.map((row) => {
    const { kind, via } = kindOf(row, ctx);
    const state = row.state ?? 'unknown';
    return {
      pid: Number(row.pid),
      backendStart: toIsoMillis(row.backend_start),
      kind,
      via,
      user: row.usename ?? '',
      database: row.datname ?? '',
      applicationName: row.application_name ?? '',
      clientAddr: row.client_addr,
      clientApp:
        kind === 'client' && row.client_addr
          ? (ctx.appByAddr.get(row.client_addr) ?? null)
          : null,
      state,
      waitEventType: row.wait_event_type,
      waitEvent: row.wait_event,
      xactAgeMs: numberOrNull(row.xact_age_ms),
      queryAgeMs: numberOrNull(row.query_age_ms),
      stateAgeMs: numberOrNull(row.state_age_ms),
      writing: !!row.writing,
      query: maskSqlLiterals(row.query),
      blockedBy: (row.blocked_by ?? []).map(Number),
      blocks: blocks.get(Number(row.pid)) ?? 0,
      actions: actionsFor(kind, state),
    };
  });
}

function numberOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toCounts(c: PgActivitySnapshot['counts']): DbSessionCountsDto {
  return {
    active: Number(c.active),
    idle: Number(c.idle),
    idleInTransaction: Number(c.idle_in_transaction),
    waiting: Number(c.waiting),
    blocked: Number(c.blocked),
  };
}

export function parseSnapshot(out: string): PgActivitySnapshot {
  const start = out.indexOf('{');
  if (start === -1) throw new Error('The database returned no session list.');
  return JSON.parse(out.slice(start).trim()) as PgActivitySnapshot;
}
