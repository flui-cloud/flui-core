import {
  POOLER_ADMIN_USER,
  POOLER_LISTEN_PORT,
} from '../../applications/utils/db-pooler.core';
import {
  DbPoolerClientDto,
  DbPoolerPoolDto,
  DbSessionAppRefDto,
} from '../dto/db-sessions.dto';

export type ShowRow = Record<string, string>;

/**
 * `psql -A -F '|'` output of a PgBouncer `SHOW` command, read by column name:
 * the columns differ between PgBouncer versions, their order included.
 */
export function parseShow(out: string): ShowRow[] {
  const lines = out
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0 && !/^\(\d+ rows?\)$/.test(l));
  if (!lines.length) return [];
  const header = lines[0].split('|');
  return lines.slice(1).map((line) => {
    const cells = line.split('|');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

const int = (v: string | undefined): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};

const waitMsOf = (row: ShowRow, seconds: string, micros: string): number =>
  int(row[seconds]) * 1000 + Math.floor(int(row[micros]) / 1000);

export interface PoolerPodShow {
  pod: string;
  pools: ShowRow[];
  clients: ShowRow[];
  servers: ShowRow[];
}

export function poolsOf(shows: PoolerPodShow[]): DbPoolerPoolDto[] {
  return shows.flatMap(({ pod, pools }) =>
    pools
      .filter((p) => p.database !== 'pgbouncer')
      .map((p) => ({
        pod,
        database: p.database ?? '',
        user: p.user ?? '',
        clientsActive: int(p.cl_active),
        clientsWaiting: int(p.cl_waiting),
        serversActive: int(p.sv_active),
        serversIdle: int(p.sv_idle),
        maxWaitMs: waitMsOf(p, 'maxwait', 'maxwait_us'),
      })),
  );
}

/**
 * A pooled client is tied to the server connection whose `ptr` its `link`
 * names, and so to that server's backend pid on the database: which is how a
 * blocker seen in the database is traced back to the application behind it.
 */
export function clientsOf(
  shows: PoolerPodShow[],
  appByAddr: ReadonlyMap<string, DbSessionAppRefDto>,
): DbPoolerClientDto[] {
  return shows.flatMap(({ pod, clients, servers }) => {
    const pidByPtr = new Map(
      servers
        .filter((s) => s.ptr && s.remote_pid)
        .map((s) => [s.ptr, int(s.remote_pid)]),
    );
    return clients
      .filter((c) => c.database !== 'pgbouncer')
      .map((c) => {
        const id = Number.parseInt(c.id ?? '', 10);
        return {
          pod,
          id: Number.isFinite(id) ? id : 0,
          addr: c.addr ?? '',
          clientApp: appByAddr.get(c.addr ?? '') ?? null,
          user: c.user ?? '',
          database: c.database ?? '',
          state: c.state ?? '',
          waitMs: waitMsOf(c, 'wait', 'wait_us'),
          serverPid: (c.link && pidByPtr.get(c.link)) || null,
          applicationName: c.application_name ?? '',
          connectTime: c.connect_time ?? '',
          canClose: Number.isFinite(id) && !!c.connect_time,
        };
      });
  });
}

export const POOLER_SHOWS = [
  'POOLS',
  'CLIENTS',
  'SERVERS',
  'DATABASES',
] as const;
export type PoolerShow = (typeof POOLER_SHOWS)[number];

const USERLIST = '/etc/pgbouncer/userlist.txt';

/**
 * The admin password is read inside the pooler pod from the user list it
 * already mounts: nothing secret travels in the exec request, whose command
 * line the API server may record.
 */
function adminPrelude(): string[] {
  return [
    'set -e',
    String.raw`PGPASSWORD="$(sed -n 's/^"${POOLER_ADMIN_USER}" "\(.*\)"$/\1/p' ${USERLIST})"`,
    'export PGPASSWORD',
  ];
}

const adminPsql = (command: string): string => {
  if (command.includes("'")) {
    throw new Error(`Not an admin console command: ${command}`);
  }
  return `psql -X -A -F '|' -v ON_ERROR_STOP=1 "host=127.0.0.1 port=${POOLER_LISTEN_PORT} dbname=pgbouncer user=${POOLER_ADMIN_USER}" -c '${command}'`;
};

export function poolerShowScript(): string {
  return [
    ...adminPrelude(),
    ...POOLER_SHOWS.flatMap((q) => [`echo '@@ ${q}'`, adminPsql(`SHOW ${q};`)]),
  ].join('\n');
}

export function killClientScript(clientId: number): string {
  if (!Number.isInteger(clientId) || clientId < 0) {
    throw new Error(`Not a pooled client id: ${clientId}`);
  }
  return [...adminPrelude(), adminPsql(`KILL_CLIENT ${clientId};`)].join('\n');
}

/** Admin console commands run one after the other in a pooler pod. */
export function poolerAdminScript(commands: string[]): string {
  return [...adminPrelude(), ...commands.map(adminPsql)].join('\n');
}

/**
 * An admin command started and left running in the pooler pod: `PAUSE` only
 * returns once the pooler holds no server connection, so nothing waits on it
 * here and its progress is read with `SHOW SERVERS`.
 */
export function poolerBackgroundAdminScript(command: string): string {
  return [
    ...adminPrelude(),
    `nohup ${adminPsql(command)} </dev/null >/dev/null 2>&1 &`,
    'exit 0',
  ].join('\n');
}

export function splitShows(out: string): Record<PoolerShow, ShowRow[]> {
  const sections: Record<PoolerShow, ShowRow[]> = {
    POOLS: [],
    CLIENTS: [],
    SERVERS: [],
    DATABASES: [],
  };
  const parts = out.split(/^@@ (\w+)\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i] as PoolerShow;
    if (name in sections) sections[name] = parseShow(parts[i + 1] ?? '');
  }
  return sections;
}

export function pausedOf(databases: ShowRow[]): boolean {
  return databases.some((d) => d.name !== 'pgbouncer' && d.paused === '1');
}

export function pausedDb(databases: ShowRow[], database: string): boolean {
  return databases.some((d) => d.name === database && d.paused === '1');
}

/** Clients of the database still queued for a server connection. */
export function waitingClients(pools: ShowRow[], database: string): number {
  return pools
    .filter((p) => p.database === database)
    .reduce((sum, p) => sum + int(p.cl_waiting), 0);
}
