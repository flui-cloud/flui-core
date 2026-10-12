import {
  clientsOf,
  killClientScript,
  parseShow,
  pausedDb,
  pausedOf,
  poolerShowScript,
  poolsOf,
  splitShows,
  waitingClients,
} from './pgbouncer-show.core';

const CLIENTS = [
  'type|user|database|replication|state|addr|port|local_addr|local_port|connect_time|request_time|wait|wait_us|close_needed|ptr|link|remote_pid|tls|application_name|prepared_statements|id',
  'C|app|app||active|10.42.0.15|51234|10.42.0.30|6432|2026-10-12 07:00:00 UTC|2026-10-12 07:00:01 UTC|0|0|0|0x1|0x9|||talk-api|0|17',
  'C|pgbouncer|pgbouncer||active|127.0.0.1|40000|127.0.0.1|6432|2026-10-12 07:00:02 UTC|2026-10-12 07:00:02 UTC|0|0|0|0x2|||||0|18',
  '(2 rows)',
].join('\n');

const SERVERS = [
  'type|user|database|state|addr|port|ptr|link|remote_pid|id',
  'S|app|app|active|10.42.0.10|5432|0x9|0x1|4242|3',
].join('\n');

const POOLS = [
  'database|user|cl_active|cl_waiting|cl_active_cancel_req|cl_waiting_cancel_req|sv_active|sv_active_cancel|sv_being_canceled|sv_idle|sv_used|sv_tested|sv_login|maxwait|maxwait_us|pool_mode',
  'app|app|3|1|0|0|2|0|0|4|0|0|0|1|500000|transaction',
  'pgbouncer|pgbouncer|1|0|0|0|0|0|0|0|0|0|0|0|0|statement',
].join('\n');

describe('the PgBouncer admin console, read by column name', () => {
  it('parses the header and drops the row count footer', () => {
    const rows = parseShow(CLIENTS);
    expect(rows).toHaveLength(2);
    expect(rows[0].application_name).toBe('talk-api');
    expect(rows[0].id).toBe('17');
  });

  it('turns pools into counts and the longest wait in ms, without its own admin pool', () => {
    expect(
      poolsOf([
        { pod: 'p-1', pools: parseShow(POOLS), clients: [], servers: [] },
      ]),
    ).toEqual([
      {
        pod: 'p-1',
        database: 'app',
        user: 'app',
        clientsActive: 3,
        clientsWaiting: 1,
        serversActive: 2,
        serversIdle: 4,
        maxWaitMs: 1500,
      },
    ]);
  });

  it('ties a pooled client to the backend pid of the server it holds', () => {
    const [client, ...rest] = clientsOf(
      [
        {
          pod: 'p-1',
          pools: [],
          clients: parseShow(CLIENTS),
          servers: parseShow(SERVERS),
        },
      ],
      new Map([['10.42.0.15', { id: 'app-1', name: 'talk-api' }]]),
    );
    expect(rest).toHaveLength(0);
    expect(client).toMatchObject({
      id: 17,
      serverPid: 4242,
      clientApp: { id: 'app-1', name: 'talk-api' },
      connectTime: '2026-10-12 07:00:00 UTC',
      canClose: true,
    });
  });
});

describe('talking to the PgBouncer admin console', () => {
  it('reads the admin password inside the pod, never from the command line', () => {
    const script = poolerShowScript();
    expect(script).toContain('/etc/pgbouncer/userlist.txt');
    expect(script).toContain('export PGPASSWORD');
    expect(script).toContain('user=flui_pooler_admin');
    expect(script).toContain('port=6432');
    for (const q of ['POOLS', 'CLIENTS', 'SERVERS', 'DATABASES']) {
      expect(script).toContain(`SHOW ${q};`);
    }
  });

  it('closes one client by its numeric id only', () => {
    expect(killClientScript(17)).toContain('KILL_CLIENT 17;');
    expect(() => killClientScript(1.5)).toThrow();
    expect(() => killClientScript(-1)).toThrow();
  });

  it('splits the four answers of one exec and reads a paused database', () => {
    const out = [
      '@@ POOLS',
      POOLS,
      '@@ CLIENTS',
      CLIENTS,
      '@@ SERVERS',
      SERVERS,
      '@@ DATABASES',
      'name|host|port|database|paused|disabled',
      'app|10.43.0.9|5432|app|1|0',
      'pgbouncer||6432|pgbouncer|0|0',
      '',
    ].join('\n');
    const shows = splitShows(out);
    expect(shows.POOLS).toHaveLength(2);
    expect(shows.CLIENTS).toHaveLength(2);
    expect(shows.SERVERS[0].remote_pid).toBe('4242');
    expect(pausedOf(shows.DATABASES)).toBe(true);
    expect(pausedOf(shows.DATABASES.slice(1))).toBe(false);
  });

  it('reads the pause and the queue of one database', () => {
    const dbs = parseShow(
      ['name|paused', 'app|1', 'other|0', 'pgbouncer|0'].join('\n'),
    );
    expect(pausedDb(dbs, 'app')).toBe(true);
    expect(pausedDb(dbs, 'other')).toBe(false);
    expect(pausedDb(dbs, 'missing')).toBe(false);
    const pools = parseShow(
      ['database|user|cl_waiting', 'app|a|2', 'app|b|1', 'other|a|5'].join(
        '\n',
      ),
    );
    expect(waitingClients(pools, 'app')).toBe(3);
    expect(waitingClients(pools, 'nope')).toBe(0);
  });
});
