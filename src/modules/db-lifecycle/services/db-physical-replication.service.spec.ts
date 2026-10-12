jest.mock('@kubernetes/client-node', () => ({}));

import {
  DbPhysicalReplicationService,
  PROMOTED_HBA_CLEANUP_SCRIPT,
  promotedSettingsResetSql,
  PromoteUnconfirmedError,
  SlotLostError,
  physicalNames,
  replicationHbaScript,
} from './db-physical-replication.service';
import { DbReplicationStatus } from '../enums/db-replication-status.enum';
import { HBA_ERRORS_SQL } from './db-write-fence.service';

const LINK_ID = '0123456789ab-cdef-0000-0000-000000000000';
const names = physicalNames(LINK_ID);

const app = (appId: string) => ({
  appId,
  pvcRoot: '/var/lib/postgresql/data',
  slug: appId,
  namespace: 'ns',
});

function setup(
  sql: (side: string, sql: string) => string = () => '',
  raw: (side: string, cmd: string) => string = () => '',
) {
  const calls: string[] = [];
  const linkRepo = {
    save: jest.fn(async (l: any) => l),
    create: (x: any) => ({ ...x }),
    findOne: jest.fn(),
  };
  const exec = {
    resolve: jest.fn(async (id: string) => app(id)),
    execSql: jest.fn(async (t: any, q: string) => {
      calls.push(`${t.appId}:sql:${q}`);
      return sql(t.appId, q);
    }),
    execSqlStream: jest.fn(async (t: any, q: string) => {
      calls.push(`${t.appId}:stream:${q}`);
    }),
    execRaw: jest.fn(async (t: any, c: string) => {
      calls.push(`${t.appId}:raw:${c}`);
      return raw(t.appId, c);
    }),
  };
  const transport = {
    ensureTls: jest.fn(async () => ({ sslWasOn: false })),
    expose: jest.fn(async () => calls.push('expose')),
    withdraw: jest.fn(async () => calls.push('withdraw')),
    serverCertificate: jest.fn(async () => 'PEM'),
    attachStandby: jest.fn(),
  };
  const wgLinks = { close: jest.fn(async () => calls.push('wg-close')) };
  const svc = new DbPhysicalReplicationService(
    linkRepo as any,
    { encrypt: (v: string) => v, decrypt: () => 'secretpw' } as any,
    exec as any,
    transport as any,
    wgLinks as any,
  );
  const link: any = {
    id: LINK_ID,
    srcAppId: 'src',
    dstAppId: 'dst',
    replRolePasswordEncrypted: 'x',
    status: DbReplicationStatus.STREAMING,
    wgLinkId: 'wg-1',
    transport: {
      mode: 'overlay',
      host: '10.250.0.2',
      port: 15432,
      svcName: names.service,
      netpolName: names.netpol,
      sslWasOn: false,
      hbaSha256Before: 'h0',
      walKeepBefore: '-1',
    },
  };
  return { svc, calls, exec, transport, wgLinks, link, linkRepo };
}

describe('DbPhysicalReplicationService', () => {
  it('admits the per-link role from the destination node only, over TLS', () => {
    const script = replicationHbaScript(
      names.replMarker,
      names.role,
      '10.250.0.3',
    );
    expect(script).toContain(
      `hostssl   replication ${names.role} 10.250.0.3/32 scram-sha-256`,
    );
    expect(script).toContain('hostnossl replication all 0.0.0.0/0 reject');
    expect(script).toContain(`# ${names.replMarker}:begin`);
  });

  it('prepares the source: secret over stdin, slot reserved now, WAL capped, file checked before reload', async () => {
    const { svc, calls, link } = setup(
      (side, q) =>
        q.startsWith('SHOW max_slot_wal_keep_size')
          ? '-1'
          : q === HBA_ERRORS_SQL
            ? '0'
            : '',
      (_side, c) =>
        c.includes('FLUI_HBA_BEFORE')
          ? 'FLUI_HBA_BEFORE=abc\n'
          : c.includes('df -B1')
            ? '8589934592'
            : '',
    );
    link.transport = undefined;
    await svc.prepareSource(link, '10.250.0.2', '10.250.0.3', 15432);

    const stream = calls.find((c) => c.startsWith('src:stream:')) as string;
    expect(stream).toContain(
      `CREATE ROLE ${names.role} WITH REPLICATION LOGIN PASSWORD 'secretpw'`,
    );
    expect(stream).toContain(
      `pg_create_physical_replication_slot('${names.slot}', true)`,
    );
    expect(
      calls.filter(
        (c) => c.includes('secretpw') && !c.startsWith('src:stream:'),
      ),
    ).toEqual([]);
    const cap = calls.indexOf(
      "src:sql:ALTER SYSTEM SET max_slot_wal_keep_size = '2048MB';\nSELECT pg_reload_conf();",
    );
    expect(cap).toBeGreaterThan(-1);
    expect(cap).toBeLessThan(calls.indexOf(stream));
    const errors = calls.indexOf(`src:sql:${HBA_ERRORS_SQL}`);
    const reload = calls.lastIndexOf('src:sql:SELECT pg_reload_conf();');
    expect(errors).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(errors);
    expect(link.transport).toMatchObject({
      mode: 'overlay',
      host: '10.250.0.2',
      dstHost: '10.250.0.3',
      sslWasOn: false,
      hbaSha256Before: 'abc',
      walKeepBefore: '-1',
      walKeepSet: '2048MB',
    });
    expect(link.transport.walKeepNote).toMatch(/every replication slot/);
  });

  it('refuses a destination address that is not an overlay IPv4', () => {
    expect(() =>
      replicationHbaScript(names.replMarker, names.role, "10.0.0.1/0' all"),
    ).toThrow(/Not an overlay address/);
  });

  it('leaves an operator cap on retained WAL alone', async () => {
    const { svc, calls, link } = setup(
      (_s, q) =>
        q.startsWith('SHOW max_slot_wal_keep_size')
          ? '1GB'
          : q === HBA_ERRORS_SQL
            ? '0'
            : '',
      (_s, c) => (c.includes('FLUI_HBA_BEFORE') ? 'FLUI_HBA_BEFORE=abc\n' : ''),
    );
    link.transport = undefined;
    await svc.prepareSource(link, '10.250.0.2', '10.250.0.3', 15432);
    expect(calls.some((c) => c.includes('SET max_slot_wal_keep_size'))).toBe(
      false,
    );
    expect(link.transport.walKeepBefore).toBe('1GB');
  });

  it('waits for the destination to replay the fence LSN, not for lag 0', async () => {
    let replays = 0;
    const { svc, calls, link } = setup((side, q) => {
      if (side === 'src') return 'true';
      if (q.includes('pg_last_wal_replay_lsn'))
        return ++replays < 3 ? 'false' : 'true';
      return '';
    });
    await svc.waitForReplay(link, '0/5A000110', { timeoutMs: 1000, pollMs: 1 });
    const dstQueries = calls.filter((c) => c.startsWith('dst:sql:'));
    expect(dstQueries).toHaveLength(3);
    expect(dstQueries[0]).toContain(
      "pg_last_wal_replay_lsn() >= '0/5A000110'::pg_lsn",
    );
    expect(calls.some((c) => c.includes('lsn_diff'))).toBe(false);
  });

  it('refuses something that is not an LSN', async () => {
    const { svc, link } = setup();
    await expect(
      svc.waitForReplay(link, "0/1'; DROP TABLE x;--", {
        timeoutMs: 1,
        pollMs: 1,
      }),
    ).rejects.toThrow(/Not an LSN/);
  });

  it('fails the link when the source lost WAL the slot needed', async () => {
    const { svc, link } = setup(() => 'streaming|0|true|lost|999');
    await expect(svc.status(link)).rejects.toBeInstanceOf(SlotLostError);
    expect(link.status).toBe(DbReplicationStatus.FAILED);
  });

  it('fails the link when its slot is gone', async () => {
    const { svc, link } = setup(() => '||||');
    await expect(svc.status(link)).rejects.toBeInstanceOf(SlotLostError);
  });

  it('reads lag and retained WAL from a healthy slot', async () => {
    const { svc, link } = setup(() => 'streaming|128|true|reserved|4096');
    expect(await svc.status(link)).toEqual({
      state: 'streaming',
      replayLagBytes: 128,
      slotActive: true,
      walStatus: 'reserved',
      retainedBytes: 4096,
    });
  });

  it('only counts a promote pg_promote confirmed', async () => {
    const { svc, link } = setup((side, q) =>
      q.includes('pg_promote') ? 'f' : 't',
    );
    await expect(svc.promote(link)).rejects.toBeInstanceOf(
      PromoteUnconfirmedError,
    );
    expect(link.status).not.toBe(DbReplicationStatus.PROMOTED);
  });

  it('promotes when pg_promote confirms and recovery is over', async () => {
    const { svc, link } = setup((_s, q) =>
      q.includes('pg_promote') ? 't' : 'f',
    );
    await svc.promote(link);
    expect(link.status).toBe(DbReplicationStatus.PROMOTED);
  });

  it('reports unknown when the destination cannot be asked', async () => {
    const { svc, exec, link } = setup();
    exec.execSql.mockRejectedValueOnce(new Error('exec failed'));
    expect(await svc.recoveryState(link)).toBe('unknown');
  });

  it('on abort drops the slot first, stops the standby dialling, and never promotes', async () => {
    const { svc, calls, link } = setup(
      (side, q) => {
        if (q.includes('pg_is_in_recovery')) return 't';
        if (q.includes('count(*) FROM pg_replication_slots')) return '1\n0';
        if (q === HBA_ERRORS_SQL) return '0';
        return '';
      },
      (_s, c) => (c.includes('FLUI_HBA_AFTER') ? 'FLUI_HBA_AFTER=h0\n' : ''),
    );
    const out = await svc.abort(link);
    expect(out.notes).toEqual([]);
    const terminate = calls.findIndex((c) =>
      c.includes('pg_terminate_backend(pid)) FROM pg_stat_replication'),
    );
    const drop = calls.findIndex((c) => c.includes('pg_drop_replication_slot'));
    const stop = calls.findIndex((c) => c.includes('flui-standby/aborted'));
    const reset = calls.findIndex(
      (c) =>
        c ===
        'dst:sql:ALTER SYSTEM RESET primary_conninfo;\nSELECT pg_reload_conf();',
    );
    expect(terminate).toBe(0);
    expect(drop).toBeGreaterThan(terminate);
    expect(stop).toBeGreaterThan(drop);
    expect(reset).toBeGreaterThan(stop);
    expect(calls.some((c) => c.includes('pg_promote'))).toBe(false);
    expect(calls).toContain(
      `src:sql:SET default_transaction_read_only = off;\nDROP ROLE IF EXISTS ${names.role};`,
    );
    expect(calls).toContain(
      'src:sql:ALTER SYSTEM RESET ssl;\nALTER SYSTEM RESET ssl_cert_file;\nALTER SYSTEM RESET ssl_key_file;\nALTER SYSTEM RESET max_slot_wal_keep_size;\nSELECT pg_reload_conf();',
    );
    expect(calls).toContain('withdraw');
    expect(calls).toContain('wg-close');
    expect(link.status).toBe(DbReplicationStatus.ABORTED);
  });

  it('says so on abort when the source pg_hba.conf no longer hashes to its original', async () => {
    const { svc, link } = setup(
      (_s, q) =>
        q.includes('count(*) FROM pg_replication_slots')
          ? '0'
          : q === HBA_ERRORS_SQL
            ? '0'
            : '',
      (_s, c) => (c.includes('FLUI_HBA_AFTER') ? 'FLUI_HBA_AFTER=other\n' : ''),
    );
    const out = await svc.abort(link);
    expect(out.notes.join()).toMatch(/changed while the link was open/);
  });

  it('resets on the promoted copy every setting the base backup brought from the source', async () => {
    const { svc, calls, link } = setup((_s, q) =>
      q === HBA_ERRORS_SQL ? '0' : '',
    );
    await svc.finishOnDestination(link);
    const reset = promotedSettingsResetSql(true);
    for (const setting of [
      'primary_conninfo',
      'primary_slot_name',
      'default_transaction_read_only',
      'ssl',
      'ssl_cert_file',
      'ssl_key_file',
      'archive_command',
      'max_slot_wal_keep_size',
    ]) {
      expect(reset).toContain(`ALTER SYSTEM RESET ${setting};`);
    }
    expect(calls).toContain(`dst:sql:${reset}`);
    expect(
      calls.some((c) => c.includes(`DROP ROLE IF EXISTS ${names.role}`)),
    ).toBe(true);
    expect(calls).toContain(`dst:raw:${PROMOTED_HBA_CLEANUP_SCRIPT}`);
    expect(PROMOTED_HBA_CLEANUP_SCRIPT).toContain('flui:repl:');
    expect(PROMOTED_HBA_CLEANUP_SCRIPT).toContain('flui:fence:');
    expect(PROMOTED_HBA_CLEANUP_SCRIPT).toContain('hostnossl all flui_repl');
    expect(calls.some((c) => c.startsWith('src:'))).toBe(false);
  });

  it('leaves the TLS settings the source owner had on the promoted copy', async () => {
    const { svc, calls, link } = setup((_s, q) =>
      q === HBA_ERRORS_SQL ? '0' : '',
    );
    link.transport.sslWasOn = true;
    await svc.finishOnDestination(link);
    const reset = calls.find((c) =>
      c.includes('RESET primary_conninfo'),
    ) as string;
    expect(reset).not.toMatch(/RESET ssl/);
    expect(reset).toContain('ALTER SYSTEM RESET archive_command;');
  });

  it('checks collation versions without a server version guard', async () => {
    const { svc, calls, link } = setup((_s, q) =>
      q.includes('system_identifier') ? '7' : '',
    );
    await svc.verifyCopy(link);
    const check = calls.find((c) => c.includes('datcollversion')) as string;
    expect(check).not.toContain('server_version_num');
    expect(check).toContain(
      'datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)',
    );
  });

  it('keeps the fence on the source after promote and closes the link', async () => {
    const { svc, calls, link } = setup(
      (_s, q) =>
        q.includes('count(*) FROM pg_replication_slots')
          ? '0'
          : q === HBA_ERRORS_SQL
            ? '0'
            : '',
      () => 'FLUI_HBA_AFTER=x\n',
    );
    await svc.finishOnSource(link);
    expect(calls.some((c) => c.includes('flui:fence'))).toBe(false);
    expect(
      calls.some((c) => c.includes(`/^# ${names.replMarker}:begin$/`)),
    ).toBe(true);
    expect(calls).toContain('wg-close');
  });

  it('removes the forward block on the source and the forward policy on the destination after promote', async () => {
    const { svc, calls, link } = setup(
      (_s, q) =>
        q.includes('count(*) FROM pg_replication_slots')
          ? '0'
          : q === HBA_ERRORS_SQL
            ? '0'
            : '',
      () => 'FLUI_HBA_AFTER=x\n',
    );
    await svc.finishOnSource(link);
    expect(
      calls.some(
        (c) =>
          c.startsWith('src:raw:') &&
          c.includes(`/^# ${names.fwdMarker}:begin$/`),
      ),
    ).toBe(true);
    expect(names.fwdMarker).toBe(`flui:fwd:${names.short}`);
    expect(names.fwdNetpol).toBe(`flui-db-fwd-${names.short}`);
  });

  it('clears forward blocks a promoted copy inherited from the source', () => {
    expect(PROMOTED_HBA_CLEANUP_SCRIPT).toContain(
      "'/^# flui:fwd:[0-9a-z]*:begin$/,/^# flui:fwd:[0-9a-z]*:end$/d'",
    );
  });
});
