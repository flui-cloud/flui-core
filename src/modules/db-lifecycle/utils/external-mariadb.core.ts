import { ExternalPgSource, sqlLiteral } from './external-pg.core';

/** The same coordinates as a PostgreSQL source; only the client flags differ. */
export type ExternalMariadbSource = ExternalPgSource;

/** Client TLS flags: `prefer` and `require` encrypt without checking the certificate, as libpq does. */
export function mariadbSslFlags(
  sslmode: ExternalMariadbSource['sslmode'],
): string {
  if (sslmode === 'disable') return '--skip-ssl';
  if (sslmode === 'verify-full') return '--ssl --ssl-verify-server-cert';
  return '--ssl --skip-ssl-verify-server-cert';
}

function sourceFlags(s: ExternalMariadbSource): string {
  return `-h '${s.host}' -P ${s.port} -u '${s.user}' ${mariadbSslFlags(s.sslmode)}`;
}

/** The source password arrives on the first line of stdin and is read by the client from MYSQL_PWD. */
function withSourcePassword(command: string): string {
  return `IFS= read -r MYSQL_PWD && export MYSQL_PWD && ${command}`;
}

export function mariadbOnSource(s: ExternalMariadbSource): string {
  return withSourcePassword(
    `mariadb ${sourceFlags(s)} --connect-timeout=10 -N -B '${s.database}'`,
  );
}

/**
 * Dumps the source into the target's database in one stream, without the data
 * ever touching the pod's disk, and prints the binlog coordinates the dump was
 * taken at: replication starts exactly there, so nothing is lost or replayed.
 */
export function mariadbCopyIntoTarget(
  s: ExternalMariadbSource,
  targetDatabase: string,
): string {
  const dump = `mariadb-dump ${sourceFlags(s)} --single-transaction --master-data=2 --routines --triggers --events --skip-add-locks --no-tablespaces '${s.database}'`;
  const keepCoordinates = `awk -v out="$coords" '/^-- CHANGE MASTER TO/ && !seen { print > out; seen = 1 } { print }'`;
  const load = `env -u MYSQL_PWD mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" '${targetDatabase}'`;
  return withSourcePassword(
    [
      'set -o pipefail; coords=$(mktemp) && trap \'rm -f "$coords"\' EXIT &&',
      `${dump} | ${keepCoordinates} | ${load} && cat "$coords"`,
    ].join(' '),
  );
}

export function parseBinlogCoordinates(
  line: string,
): { file: string; position: number } | null {
  const file = /MASTER_LOG_FILE='([^']+)'/.exec(line)?.[1];
  const position = Number(/MASTER_LOG_POS=(\d+)/.exec(line)?.[1]);
  return file && Number.isFinite(position) && position > 0
    ? { file, position }
    : null;
}

export const MARIADB_SOURCE_PREFLIGHT_SQL = [
  `SELECT CONCAT('version|', VERSION());`,
  `SELECT CONCAT('log_bin|', @@log_bin);`,
  `SELECT CONCAT('binlog_format|', @@binlog_format);`,
  `SELECT CONCAT('server_id|', @@server_id);`,
  `SELECT CONCAT('tables|', COUNT(*)) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE';`,
  `SHOW GRANTS;`,
].join('\n');

export interface MariadbSourcePreflight {
  version: string;
  logBin: boolean;
  binlogFormat: string;
  serverId: number;
  tables: number;
  canReplicate: boolean;
  canLock: boolean;
  canReadPosition: boolean;
}

function readGrant(line: string, into: MariadbSourcePreflight): void {
  const all = /ALL PRIVILEGES ON \*\.\*/i.test(line);
  into.canReplicate ||= all || /REPLICATION (SLAVE|REPLICA)/i.test(line);
  into.canLock ||= all || /\bRELOAD\b/i.test(line);
  into.canReadPosition ||=
    all || /BINLOG MONITOR|REPLICATION CLIENT|\bSUPER\b/i.test(line);
}

const PREFLIGHT_FIELDS: Record<
  string,
  (into: MariadbSourcePreflight, value: string) => void
> = {
  version: (into, v) => (into.version = v),
  log_bin: (into, v) => (into.logBin = /^(1|on)$/i.test(v)),
  binlog_format: (into, v) => (into.binlogFormat = v.toUpperCase()),
  server_id: (into, v) => (into.serverId = Number(v)),
  tables: (into, v) => (into.tables = Number(v)),
};

export function parseMariadbPreflight(output: string): MariadbSourcePreflight {
  const result: MariadbSourcePreflight = {
    version: '',
    logBin: false,
    binlogFormat: '',
    serverId: 0,
    tables: 0,
    canReplicate: false,
    canLock: false,
    canReadPosition: false,
  };
  for (const line of output.split('\n')) {
    if (/^GRANT /i.test(line)) {
      readGrant(line, result);
      continue;
    }
    const at = line.indexOf('|');
    if (at < 0) continue;
    PREFLIGHT_FIELDS[line.slice(0, at).trim()]?.(
      result,
      line.slice(at + 1).trim(),
    );
  }
  return result;
}

export function mariadbPreflightProblems(p: MariadbSourcePreflight): string[] {
  const problems: string[] = [];
  if (p.version && !/mariadb/i.test(p.version)) {
    problems.push(
      `The source is not MariaDB (${p.version}). Importing from MySQL is not supported yet.`,
    );
  }
  if (!p.logBin) {
    problems.push(
      'Binary logging is off on the source: set log_bin and restart it.',
    );
  }
  if (p.binlogFormat && p.binlogFormat !== 'ROW') {
    problems.push(
      `binlog_format on the source is ${p.binlogFormat}; set it to ROW.`,
    );
  }
  if (!p.canReplicate) {
    problems.push(
      'The source user cannot replicate: grant it REPLICATION SLAVE (REPLICATION REPLICA) on *.*.',
    );
  }
  if (!p.canReadPosition) {
    problems.push(
      'The source user cannot read the binary log position: grant it BINLOG MONITOR (REPLICATION CLIENT before MariaDB 10.5) on *.*.',
    );
  }
  if (!p.canLock) {
    problems.push(
      'The source user cannot take a consistent copy with its position: grant it RELOAD on *.*.',
    );
  }
  return problems;
}

/** A server id for the copy that cannot be the source's. */
export function replicaServerId(sourceServerId: number, seed: number): number {
  const id = 1000 + (Math.abs(Math.trunc(seed)) % 4_000_000);
  return id === sourceServerId ? id + 1 : id;
}

export function startReplicationSql(
  s: ExternalMariadbSource,
  password: string,
  coords: { file: string; position: number },
  targetDatabase: string,
  serverId: number,
): string {
  let tls = 'MASTER_SSL = 0';
  if (s.sslmode !== 'disable') {
    const verify = s.sslmode === 'verify-full' ? 1 : 0;
    tls = `MASTER_SSL = 1, MASTER_SSL_VERIFY_SERVER_CERT = ${verify}`;
  }
  const rewrite = sqlLiteral(`${s.database}->${targetDatabase}`);
  const tables = sqlLiteral(`${targetDatabase}.%`);
  return [
    'STOP SLAVE;',
    `SET GLOBAL server_id = ${serverId};`,
    `SET GLOBAL replicate_rewrite_db = ${rewrite};`,
    // By the tables a statement touches, not by the session's default
    // database: an application writing elsewhere while ours is selected would
    // otherwise replay that write here and stop replication.
    `SET GLOBAL replicate_wild_do_table = ${tables};`,
    `CHANGE MASTER TO MASTER_HOST = ${sqlLiteral(s.host)}, MASTER_PORT = ${s.port}, MASTER_USER = ${sqlLiteral(s.user)}, MASTER_PASSWORD = ${sqlLiteral(password)}, MASTER_LOG_FILE = ${sqlLiteral(coords.file)}, MASTER_LOG_POS = ${coords.position}, ${tls};`,
    'START SLAVE;',
  ].join('\n');
}

export const STOP_REPLICATION_SQL = [
  'STOP SLAVE;',
  'RESET SLAVE ALL;',
  "SET GLOBAL replicate_wild_do_table = '';",
  "SET GLOBAL replicate_rewrite_db = '';",
  'SET GLOBAL server_id = 1;',
].join('\n');

export interface ReplicaStatus {
  ioRunning: boolean;
  sqlRunning: boolean;
  secondsBehind: number | null;
  error: string | null;
  readFile: string;
  readPosition: number;
  execFile: string;
  execPosition: number;
}

/** Reads `SHOW SLAVE STATUS\G`. */
export function parseReplicaStatus(output: string): ReplicaStatus | null {
  const fields = new Map<string, string>();
  for (const line of output.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }
  const field = (name: string) => fields.get(name) ?? '';
  if (!field('Master_Host')) return null;
  const behind = field('Seconds_Behind_Master');
  const error = field('Last_IO_Error') || field('Last_SQL_Error');
  return {
    ioRunning: field('Slave_IO_Running') === 'Yes',
    sqlRunning: field('Slave_SQL_Running') === 'Yes',
    secondsBehind: behind === '' || behind === 'NULL' ? null : Number(behind),
    error: error || null,
    readFile: field('Master_Log_File'),
    readPosition: Number(field('Read_Master_Log_Pos')),
    execFile: field('Relay_Master_Log_File'),
    execPosition: Number(field('Exec_Master_Log_Pos')),
  };
}

/** `SHOW MASTER STATUS` on the source: where its writes have got to. */
export function parseMasterStatus(
  output: string,
): { file: string; position: number } | null {
  const [file, position] = output.trim().split('\n')[0]?.split('\t') ?? [];
  return file && Number(position) > 0
    ? { file, position: Number(position) }
    : null;
}
