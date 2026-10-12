import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  coerceBoolean,
  coerceNumber,
  defineTool,
  ToolDef,
} from './mcp-tool.util';

const enc = encodeURIComponent;

const MODEL_QUERY_MAX = 200;

interface SessionView {
  pid: number;
  backendStart: string;
  kind: string;
  via: string;
  clientApp: { name: string } | null;
  state: string;
  waitEventType: string | null;
  waitEvent: string | null;
  xactAgeMs: number | null;
  queryAgeMs: number | null;
  blockedBy: number[];
  blocks: number;
  writing: boolean;
  query: string;
  actions: { cancel: boolean; terminate: boolean; reason: string | null };
}

interface SessionsView {
  capturedAt: string;
  maxConnections: number;
  total: number;
  truncated: boolean;
  counts: Record<string, number>;
  sessions: SessionView[];
  pooler: unknown;
}

export function sessionsForModel(data: unknown): unknown {
  const v = data as SessionsView | null;
  if (!v?.sessions) return data;
  return {
    capturedAt: v.capturedAt,
    connected: `${v.total} of ${v.maxConnections}`,
    counts: v.counts,
    truncated: v.truncated,
    sessions: v.sessions.map((s) => ({
      pid: s.pid,
      backendStart: s.backendStart,
      kind: s.kind,
      via: s.via,
      app: s.clientApp?.name ?? null,
      state: s.state,
      waitingOn: s.waitEventType ? `${s.waitEventType}:${s.waitEvent}` : null,
      xactAgeMs: s.xactAgeMs,
      queryAgeMs: s.queryAgeMs,
      writing: s.writing,
      blockedBy: s.blockedBy,
      blocks: s.blocks,
      query: s.query.slice(0, MODEL_QUERY_MAX),
      actions: s.actions,
    })),
    pooler: v.pooler,
  };
}

const actionInput = {
  id: z.string(),
  pid: coerceNumber(z.number().int().positive()),
  backendStart: z.string(),
};

/**
 * Active sessions of a managed PostgreSQL. Reading them is a data read; ending
 * one is a write that pauses for a person (`@ActionCycle` on the route).
 */
export const DB_SESSIONS_TOOLS: ToolDef[] = [
  defineTool({
    name: 'db_sessions',
    routes: ['GET /applications/:id/db/sessions'],
    description:
      'List the sessions connected to a managed PostgreSQL database (pass the database application id): who (application or address), state, how long its transaction and statement have run, what it waits for, which sessions block which (blockedBy / blocks), and the statement with every literal masked. Idle sessions are left out unless all=true. Each session says which actions are allowed and why not. Use it when an application reports too many connections, timeouts or locks.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string(), all: coerceBoolean().optional() },
    run: (args, ctx) =>
      ctx.api.get(
        `/applications/${enc(args.id)}/db/sessions${args.all ? '?all=true' : ''}`,
      ),
    forModel: sessionsForModel,
  }),
  defineTool({
    name: 'db_session_cancel',
    routes: ['POST /applications/:id/db/sessions/:pid/cancel'],
    description:
      'Cancel the statement a database session is running (pass pid and backendStart exactly as db_sessions returned them). The statement fails with an error in the application that sent it; the connection stays open. A person approves it before it happens. Refused with 409 when that session has ended since.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: actionInput,
    run: (args, ctx) =>
      ctx.api.post(
        `/applications/${enc(args.id)}/db/sessions/${enc(String(args.pid))}/cancel`,
        { backendStart: args.backendStart },
      ),
  }),
  defineTool({
    name: 'db_session_terminate',
    routes: ['POST /applications/:id/db/sessions/:pid/terminate'],
    description:
      'Close a database session (pass pid and backendStart exactly as db_sessions returned them). Its open transaction is rolled back and the application has to reconnect. Prefer db_session_cancel when stopping the statement is enough. A person approves it before it happens. Refused with 409 when that session has ended since.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: actionInput,
    run: (args, ctx) =>
      ctx.api.post(
        `/applications/${enc(args.id)}/db/sessions/${enc(String(args.pid))}/terminate`,
        { backendStart: args.backendStart },
      ),
  }),
  defineTool({
    name: 'db_pooler_client_close',
    routes: ['POST /applications/:id/db/pooler/clients/:clientId/close'],
    description:
      'Close a connection held by the pooler of a managed PostgreSQL (pass clientId, pod and connectTime exactly as db_sessions returned them under pooler.clients). The server connection it held is closed too, its open transaction rolled back, and the application has to reconnect. A person approves it before it happens. Refused with 409 when that client has ended since.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      clientId: coerceNumber(z.number().int().nonnegative()),
      pod: z.string(),
      connectTime: z.string(),
    },
    run: (args, ctx) =>
      ctx.api.post(
        `/applications/${enc(args.id)}/db/pooler/clients/${enc(String(args.clientId))}/close`,
        { pod: args.pod, connectTime: args.connectTime },
      ),
  }),
  defineTool({
    name: 'db_pooler_get',
    routes: ['GET /applications/:id/db/pooler'],
    description:
      'The connection pooler of a managed PostgreSQL (pass the database application id): whether it has one, its mode (transaction or session), whether FLUI_CONNECTION_URL goes through it and, when it does not, why, its pods, and the two in-cluster addresses: pooled (FLUI_CONNECTION_URL) and direct (FLUI_DIRECT_URL, for migrations, LISTEN and admin tools). The pooler is chosen at install.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.api.get(`/applications/${enc(args.id)}/db/pooler`),
  }),
];
