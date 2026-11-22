/** A PostgreSQL that Flui does not manage, read from the target's own pod. */
export interface ExternalPgSource {
  host: string;
  port: number;
  database: string;
  user: string;
  sslmode: ExternalPgSslMode;
}

export const EXTERNAL_PG_SSL_MODES = [
  'disable',
  'prefer',
  'require',
  'verify-full',
] as const;
export type ExternalPgSslMode = (typeof EXTERNAL_PG_SSL_MODES)[number];

const HOST_CHARS = /^[A-Za-z0-9.-]{1,253}$/;
const IPV6 = /^[0-9A-Fa-f:]+$/;
const NAME = /^\w[\w.$-]{0,62}$/;

function isHostname(host: string): boolean {
  const edges = /^[A-Za-z0-9]/.test(host) && /[A-Za-z0-9]$/.test(host);
  return HOST_CHARS.test(host) && edges;
}

/** Everything here ends up inside a shell word and a libpq conninfo, so it is checked, not escaped. */
export function externalPgSourceProblems(
  s: Partial<ExternalPgSource>,
): string[] {
  const problems: string[] = [];
  if (!s.host || !(isHostname(s.host) || IPV6.test(s.host))) {
    problems.push('host must be a host name or an IP address');
  }
  if (!Number.isInteger(s.port) || s.port! < 1 || s.port! > 65535) {
    problems.push('port must be between 1 and 65535');
  }
  if (!s.database || !NAME.test(s.database)) {
    problems.push('database must be a plain database name');
  }
  if (!s.user || !NAME.test(s.user)) {
    problems.push('user must be a plain role name');
  }
  if (!s.sslmode || !EXTERNAL_PG_SSL_MODES.includes(s.sslmode)) {
    problems.push(`sslmode must be one of ${EXTERNAL_PG_SSL_MODES.join(', ')}`);
  }
  return problems;
}

/** The conninfo without the password, which always travels on stdin or inside the subscription. */
export function externalPgConninfo(s: ExternalPgSource): string {
  return `host=${s.host} port=${s.port} dbname=${s.database} user=${s.user} sslmode=${s.sslmode} connect_timeout=10`;
}

/** A conninfo value quoted for libpq, for the subscription, which holds the password. */
export function conninfoWithPassword(
  s: ExternalPgSource,
  password: string,
): string {
  const backslash = String.fromCodePoint(92);
  const escaped = password
    .replaceAll(backslash, backslash + backslash)
    .replaceAll("'", `${backslash}'`);
  const quoted = `'${escaped}'`;
  return `${externalPgConninfo(s)} password=${quoted}`;
}

/** A SQL string literal. */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Runs a libpq client against the source with the password read from the
 * first line of stdin: it never appears in a command line or in the pod spec.
 */
export function withSourcePassword(command: string): string {
  return `IFS= read -r PGPASSWORD && export PGPASSWORD && ${command}`;
}

export function psqlOnSource(s: ExternalPgSource): string {
  return withSourcePassword(
    `psql '${externalPgConninfo(s)}' -v ON_ERROR_STOP=1 -tA -f -`,
  );
}

/** Schemas Flui creates in its own PostgreSQL; a source that is one carries them too. */
export const FLUI_SCHEMA_PATTERN = 'flui_*';

export function schemaDumpOfSource(s: ExternalPgSource): string {
  return withSourcePassword(
    `pg_dump --schema-only --no-owner --no-privileges --no-publications --no-subscriptions --exclude-schema='${FLUI_SCHEMA_PATTERN}' '${externalPgConninfo(s)}'`,
  );
}

/** All or nothing: a schema half restored would make the next attempt refuse a database that is no longer empty. */
export function inOneTransaction(sql: string): string {
  return `BEGIN;\n${sql}\nCOMMIT;\n`;
}

/** One row per line, `|`-separated: what the preflight needs to know about the source. */
export const SOURCE_PREFLIGHT_SQL = [
  `SELECT 'version|' || current_setting('server_version_num');`,
  `SELECT 'wal_level|' || current_setting('wal_level');`,
  `SELECT 'replication|' || (rolreplication OR rolsuper OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'rds_replication' AND pg_has_role(current_user, r.oid, 'member')))::text FROM pg_roles WHERE rolname = current_user;`,
  `SELECT 'slots_free|' || (current_setting('max_replication_slots')::int - (SELECT count(*) FROM pg_replication_slots))::text;`,
  String.raw`SELECT 'tables|' || count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'flui\_%';`,
  String.raw`SELECT 'no_pk|' || c.oid::regclass::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'flui\_%' AND c.relreplident = 'd' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary);`,
].join('\n');

export interface SourcePreflight {
  versionNum: number;
  walLevel: string;
  canReplicate: boolean;
  freeSlots: number;
  tables: number;
  tablesWithoutKey: string[];
}

export function parseSourcePreflight(output: string): SourcePreflight {
  const result: SourcePreflight = {
    versionNum: 0,
    walLevel: '',
    canReplicate: false,
    freeSlots: 0,
    tables: 0,
    tablesWithoutKey: [],
  };
  for (const line of output.split('\n')) {
    const at = line.indexOf('|');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === 'version') result.versionNum = Number(value);
    else if (key === 'wal_level') result.walLevel = value;
    else if (key === 'replication') result.canReplicate = value === 'true';
    else if (key === 'slots_free') result.freeSlots = Number(value);
    else if (key === 'tables') result.tables = Number(value);
    else if (key === 'no_pk') result.tablesWithoutKey.push(value);
  }
  return result;
}

/** What stops an import before anything is written, said so a person can fix it on the source. */
export function sourcePreflightProblems(p: SourcePreflight): string[] {
  const problems: string[] = [];
  if (p.versionNum < 100000) {
    problems.push(
      'The source runs PostgreSQL older than 10, which has no logical replication.',
    );
  }
  if (p.versionNum >= 180000) {
    problems.push(
      'The source runs a newer PostgreSQL than the Flui one (17): import into a newer Flui PostgreSQL once it is available.',
    );
  }
  if (p.walLevel !== 'logical') {
    problems.push(
      `wal_level on the source is "${p.walLevel || 'unknown'}"; set it to logical and restart the source (on managed services this is a parameter, such as rds.logical_replication on RDS).`,
    );
  }
  if (!p.canReplicate) {
    problems.push(
      'The source user cannot replicate: give it the REPLICATION attribute (rds_replication on RDS).',
    );
  }
  if (p.freeSlots < 1) {
    problems.push(
      'The source has no free replication slot: raise max_replication_slots or drop an unused slot.',
    );
  }
  return problems;
}

/** Postgres object names derived from the import id: short, lowercase, collision-free. */
export function importObjectNames(importId: string): {
  publication: string;
  subscription: string;
  slot: string;
} {
  const short = importId.replaceAll('-', '').slice(0, 12).toLowerCase();
  return {
    publication: `flui_import_${short}`,
    subscription: `flui_import_${short}`,
    slot: `flui_import_${short}`,
  };
}

/**
 * Tables without a primary key cannot have UPDATE or DELETE published until
 * they carry a full replica identity: with a publication for all tables, the
 * source would refuse those statements outright.
 */
export function replicaIdentitySql(
  tables: string[],
  to: 'FULL' | 'DEFAULT',
): string {
  return tables
    .map((t) => `ALTER TABLE ${t} REPLICA IDENTITY ${to};`)
    .join('\n');
}

export const SOURCE_SEQUENCES_SQL = `SELECT format('SELECT setval(%L, %s, true);', quote_ident(schemaname) || '.' || quote_ident(sequencename), last_value) FROM pg_sequences WHERE last_value IS NOT NULL;`;

export function sourceLagSql(slot: string): string {
  return `SELECT COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), -1)::bigint FROM pg_replication_slots WHERE slot_name = ${sqlLiteral(slot)};`;
}

export function subscriptionStateSql(subscription: string): string {
  return `SELECT count(*) FILTER (WHERE r.srsubstate <> 'r')::text || '|' || count(*)::text FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid = r.srsubid WHERE s.subname = ${sqlLiteral(subscription)};`;
}
