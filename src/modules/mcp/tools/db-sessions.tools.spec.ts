import { DB_SESSIONS_TOOLS, sessionsForModel } from './db-sessions.tools';
import { MCP_SCOPE } from '../constants/mcp-scopes';

const tool = (name: string) => DB_SESSIONS_TOOLS.find((t) => t.name === name);

describe('the database sessions tools', () => {
  it('reads on mcp:app:read and acts on mcp:app:write, never destructive', () => {
    expect(tool('db_sessions')?.scope).toBe(MCP_SCOPE.APP_READ);
    expect(tool('db_session_cancel')?.scope).toBe(MCP_SCOPE.APP_WRITE);
    expect(tool('db_session_terminate')?.scope).toBe(MCP_SCOPE.APP_WRITE);
    expect(tool('db_pooler_client_close')?.scope).toBe(MCP_SCOPE.APP_WRITE);
    expect(tool('db_pooler_get')?.scope).toBe(MCP_SCOPE.APP_READ);
  });

  it('hands the model a short view with the actions the API allows', () => {
    const view = sessionsForModel({
      capturedAt: '2026-10-12T07:00:00.000Z',
      maxConnections: 100,
      total: 2,
      truncated: false,
      counts: { active: 1 },
      pooler: null,
      sessions: [
        {
          pid: 42,
          backendStart: '2026-10-12T06:00:00.123Z',
          kind: 'client',
          via: 'direct',
          user: 'owner',
          clientAddr: '10.42.0.15',
          clientApp: { id: 'a-1', name: 'talk-api' },
          state: 'active',
          waitEventType: 'Lock',
          waitEvent: 'transactionid',
          xactAgeMs: 5000,
          queryAgeMs: 4000,
          writing: true,
          blockedBy: [7],
          blocks: 0,
          query: `SELECT ${'x, '.repeat(200)}`,
          actions: { cancel: true, terminate: true, reason: null },
        },
      ],
    }) as { connected: string; sessions: Array<Record<string, unknown>> };
    expect(view.connected).toBe('2 of 100');
    const [s] = view.sessions;
    expect(s).toMatchObject({
      pid: 42,
      backendStart: '2026-10-12T06:00:00.123Z',
      app: 'talk-api',
      waitingOn: 'Lock:transactionid',
      blockedBy: [7],
      actions: { cancel: true, terminate: true, reason: null },
    });
    expect(s.query as string).toHaveLength(200);
    expect(s).not.toHaveProperty('clientAddr');
    expect(s).not.toHaveProperty('user');
  });
});
