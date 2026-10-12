import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';
import { resolveClusterRef } from './resolve-cluster';
import { resolveApp } from './resolve-app';
import {
  DbPooledClientView,
  DbSessionView,
  DbSessionsView,
  pooledClientDescription,
  sessionDescription as describeSession,
} from './db-sessions-view';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionAction = 'cancel' | 'terminate';

export class DbSessionsClient {
  private constructor(private readonly api: ApiClient) {}

  static fromConfig(): DbSessionsClient {
    const cfg = new ConfigStorage();
    return new DbSessionsClient(
      new ApiClient({
        baseUrl: cfg.getApiUrlOrThrow(),
        apiKey: cfg.getApiKeyOrThrow(),
      }),
    );
  }

  async resolveDb(
    nameOrId: string,
    clusterFlag?: string,
  ): Promise<{ id: string; name: string }> {
    if (UUID_RE.test(nameOrId)) return { id: nameOrId, name: nameOrId };
    const cluster = await resolveClusterRef(clusterFlag);
    return resolveApp(cluster.id, nameOrId);
  }

  list(dbId: string, all = false): Promise<DbSessionsView> {
    return this.api.get<DbSessionsView>(
      `/applications/${encodeURIComponent(dbId)}/db/sessions${all ? '?all=true' : ''}`,
    );
  }

  async find(dbId: string, pid: number): Promise<DbSessionView | null> {
    const view = await this.list(dbId, true);
    return view.sessions.find((s) => s.pid === pid) ?? null;
  }

  closeClient(
    dbId: string,
    client: Pick<DbPooledClientView, 'id' | 'pod' | 'connectTime'>,
  ): Promise<{ clientId: number; pod: string; message: string }> {
    return this.api.post(
      `/applications/${encodeURIComponent(dbId)}/db/pooler/clients/${client.id}/close`,
      { pod: client.pod, connectTime: client.connectTime },
    );
  }

  act(
    dbId: string,
    session: Pick<DbSessionView, 'pid' | 'backendStart'>,
    action: SessionAction,
  ): Promise<{ pid: number; action: SessionAction; message: string }> {
    return this.api.post(
      `/applications/${encodeURIComponent(dbId)}/db/sessions/${session.pid}/${action}`,
      { backendStart: session.backendStart },
    );
  }
}

const QUESTION: Record<SessionAction, string> = {
  cancel:
    'Cancel the statement this session is running? It fails with an error in the application; the connection stays open.',
  terminate:
    'Close this session? Its open transaction is rolled back and the application has to reconnect.',
};

export interface SessionActionIo {
  log: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
}

/**
 * Reads the session first, so the start time sent back is the one the API
 * returned and a pid reused since is never hit, then asks unless told not to.
 */
export async function performSessionAction(
  io: SessionActionIo,
  action: SessionAction,
  input: { db: string; pid: number; cluster?: string; yes: boolean },
): Promise<string | null> {
  const client = DbSessionsClient.fromConfig();
  const db = await client.resolveDb(input.db, input.cluster);
  const session = await client.find(db.id, input.pid);
  if (!session) {
    throw new Error(
      `No session ${input.pid} on ${db.name}: it may have ended.`,
    );
  }
  if (!session.actions[action]) {
    throw new Error(
      session.actions.reason ??
        `Flui does not offer to ${action} session ${input.pid}.`,
    );
  }
  for (const line of describeSession(session)) io.log(`  ${line}`);
  if (!input.yes && !(await io.confirm(QUESTION[action]))) {
    return null;
  }
  const result = await client.act(db.id, session, action);
  return result.message;
}

/**
 * Same shape as a session: the client is read first so the connect time sent
 * back is the listed one, and a client id reused since is never hit.
 */
export async function performPooledClientClose(
  io: SessionActionIo,
  input: {
    db: string;
    clientId: number;
    pod?: string;
    cluster?: string;
    yes: boolean;
  },
): Promise<string | null> {
  const client = DbSessionsClient.fromConfig();
  const db = await client.resolveDb(input.db, input.cluster);
  const view = await client.list(db.id, true);
  if (!view.pooler) throw new Error(`${db.name} has no connection pooler.`);
  const matches = view.pooler.clients.filter(
    (c) => c.id === input.clientId && (!input.pod || c.pod === input.pod),
  );
  if (matches.length > 1) {
    throw new Error(
      `Client ${input.clientId} exists on several pooler pods (${matches
        .map((c) => c.pod)
        .join(', ')}). Pass --pod.`,
    );
  }
  const found = matches[0];
  if (!found) {
    throw new Error(
      `No pooled client ${input.clientId} on ${db.name}: it may have ended.`,
    );
  }
  if (!found.canClose) {
    throw new Error(`Flui does not offer to close client ${input.clientId}.`);
  }
  for (const line of pooledClientDescription(found)) io.log(`  ${line}`);
  if (
    !input.yes &&
    !(await io.confirm(
      'Close this pooled connection? The server connection it holds is closed too and the application has to reconnect.',
    ))
  ) {
    return null;
  }
  const result = await client.closeClient(db.id, found);
  return result.message;
}
