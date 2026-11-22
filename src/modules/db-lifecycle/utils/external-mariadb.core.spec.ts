import {
  mariadbCopyIntoTarget,
  mariadbOnSource,
  mariadbPreflightProblems,
  mariadbSslFlags,
  parseBinlogCoordinates,
  parseMariadbPreflight,
  parseMasterStatus,
  parseReplicaStatus,
  replicaServerId,
  startReplicationSql,
  STOP_REPLICATION_SQL,
} from './external-mariadb.core';

const source = {
  host: 'db.example.com',
  port: 3306,
  database: 'shop',
  user: 'rep',
  sslmode: 'require' as const,
};

describe('an external MariaDB source', () => {
  it('maps TLS modes to client flags', () => {
    expect(mariadbSslFlags('disable')).toBe('--skip-ssl');
    expect(mariadbSslFlags('require')).toBe(
      '--ssl --skip-ssl-verify-server-cert',
    );
    expect(mariadbSslFlags('verify-full')).toBe(
      '--ssl --ssl-verify-server-cert',
    );
  });

  it('reads the password from stdin, never from the command line', () => {
    const cmd = mariadbOnSource(source);
    expect(
      cmd.startsWith('IFS= read -r MYSQL_PWD && export MYSQL_PWD && mariadb '),
    ).toBe(true);
    expect(cmd).not.toMatch(/-p\S/);
  });

  it('streams the dump into the target, keeping the binlog position and failing on any broken step', () => {
    const cmd = mariadbCopyIntoTarget(source, 'app');
    expect(cmd).toContain('set -o pipefail;');
    expect(cmd).toContain('--single-transaction --master-data=2');
    expect(cmd).toContain('/^-- CHANGE MASTER TO/');
    expect(cmd).toContain('coords=$(mktemp)');
    expect(cmd).toMatch(/&& cat "\$coords"$/);
    expect(cmd).toContain(`mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" 'app'`);
    expect(cmd).not.toContain('--connect-timeout');
  });

  it('reads the position the dump was taken at', () => {
    expect(
      parseBinlogCoordinates(
        "-- CHANGE MASTER TO MASTER_LOG_FILE='binlog.000002', MASTER_LOG_POS=50526;",
      ),
    ).toEqual({ file: 'binlog.000002', position: 50526 });
    expect(parseBinlogCoordinates('')).toBeNull();
  });

  it('accepts a ready MariaDB 12 source, as it answers', () => {
    const p = parseMariadbPreflight(
      [
        'version|12.3.3-MariaDB-ubu2404-log',
        'log_bin|ON',
        'binlog_format|ROW',
        'server_id|1',
        'tables|2',
        'GRANT RELOAD, BINLOG MONITOR, REPLICATION SLAVE ON *.* TO `rep`@`%`',
      ].join('\n'),
    );
    expect(p).toMatchObject({ logBin: true, serverId: 1, tables: 2 });
    expect(mariadbPreflightProblems(p)).toEqual([]);
  });

  it('names every missing piece, and refuses MySQL for now', () => {
    const p = parseMariadbPreflight(
      [
        'version|8.0.36',
        'log_bin|OFF',
        'binlog_format|MIXED',
        'GRANT SELECT ON *.* TO `x`',
      ].join('\n'),
    );
    expect(mariadbPreflightProblems(p)).toHaveLength(6);
  });

  it('never gives the copy the source server id', () => {
    for (const seed of [0, 1, 999, 4_000_000, 123456789]) {
      expect(replicaServerId(1000 + (seed % 4_000_000), seed)).not.toBe(
        1000 + (seed % 4_000_000),
      );
    }
  });

  it('follows only the imported database, renamed to the target one', () => {
    const sql = startReplicationSql(
      source,
      "p'w",
      { file: 'binlog.000002', position: 4 },
      'app',
      1234,
    );
    expect(sql).toContain("SET GLOBAL replicate_rewrite_db = 'shop->app';");
    expect(sql).toContain("SET GLOBAL replicate_wild_do_table = 'app.%';");
    expect(sql).not.toContain('replicate_do_db');
    expect(sql).toContain("MASTER_PASSWORD = 'p''w'");
    expect(sql).toContain('MASTER_SSL = 1, MASTER_SSL_VERIFY_SERVER_CERT = 0');
    expect(STOP_REPLICATION_SQL).toContain('RESET SLAVE ALL;');
  });

  it('reads replica status without taking the next line for an empty error', () => {
    const status = parseReplicaStatus(
      [
        '                Master_Host: db.example.com',
        '            Master_Log_File: binlog.000002',
        '        Read_Master_Log_Pos: 57970',
        '      Relay_Master_Log_File: binlog.000002',
        '           Slave_IO_Running: Yes',
        '          Slave_SQL_Running: Yes',
        '        Exec_Master_Log_Pos: 57970',
        '      Seconds_Behind_Master: 0',
        '              Last_IO_Error: ',
        '             Last_SQL_Errno: 0',
        '             Last_SQL_Error: ',
      ].join('\n'),
    );
    expect(status).toEqual({
      ioRunning: true,
      sqlRunning: true,
      secondsBehind: 0,
      error: null,
      readFile: 'binlog.000002',
      readPosition: 57970,
      execFile: 'binlog.000002',
      execPosition: 57970,
    });
    expect(parseReplicaStatus('')).toBeNull();
    expect(parseMasterStatus('binlog.000002\t57970\t\t\n')).toEqual({
      file: 'binlog.000002',
      position: 57970,
    });
  });
});
