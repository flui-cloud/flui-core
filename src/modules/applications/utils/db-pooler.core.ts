import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export type PoolerMode = 'transaction' | 'session';

export type PoolerUpstream =
  | { mode: 'local' }
  | { mode: 'forward'; address: string; port: number; linkId: string };

/**
 * The connection pooler of a managed PostgreSQL, stored on the database's own
 * application row. `null` on the row means no pooler, which is what every
 * install made before the pooler existed reads as: the state is written once at
 * install and never derived again from the install's options.
 */
export interface PoolerSpec {
  enabled: boolean;
  mode: PoolerMode;
  replicas: number;
  /** Resolved and pinned at install, so an API upgrade never rolls every pooler. */
  image: string;
  authPasswordEnc: string;
  adminPasswordEnc: string;
  upstream: PoolerUpstream;
  /** Kept so the upstream Service can be recreated on the same address. */
  upstreamClusterIP?: string | null;
  suspended?: boolean;
  /** `FLUI_CONNECTION_URL` points at the pooler. False until the pooler proved ready. */
  routed?: boolean;
  /** Why the pooler is not carrying the connection URL, in words a person can act on. */
  lastError?: string | null;
  enabledAt: string;
}

export const POOLER_RESOURCES: {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
} = {
  requests: { cpu: '25m', memory: '32Mi' },
  limits: { cpu: '500m', memory: '128Mi' },
};

export const POOLER_LISTEN_PORT = 6432;
export const POOLER_SERVICE_PORT = 5432;
export const POOLER_ROLE = 'flui_pooler';
export const POOLER_ADMIN_USER = 'flui_pooler_admin';
export const POOLER_OF_LABEL = 'flui.cloud/pooler-of';
export const POOLER_CONFIG_HASH_ANNOTATION = 'flui.cloud/pooler-config-hash';
export const POOLER_IMAGE_ENV = 'FLUI_PGBOUNCER_IMAGE';
export const DEFAULT_PGBOUNCER_IMAGE =
  'ghcr.io/cloudnative-pg/pgbouncer:1.26.0@sha256:ce54f1133c509f1db8a8092c3f1c761d8c9292065ed6b6698786bb966da4dab9';
/** What a pause raises at runtime, and what `RELOAD` puts back from the configuration file. */
export const POOLER_QUERY_WAIT_TIMEOUT_DEFAULT_S = 120;
export const POOLER_LOGIN_TIMEOUT_DEFAULT_S = 60;
export const POOLER_UID = 998;
export const POOLER_GID = 996;

export function pgbouncerImage(env: NodeJS.ProcessEnv = process.env): string {
  return env[POOLER_IMAGE_ENV]?.trim() || DEFAULT_PGBOUNCER_IMAGE;
}

export interface PoolerNames {
  deployment: string;
  secret: string;
  service: string;
  upstream: string;
  forwardSlice: string;
}

export function poolerNames(slug: string): PoolerNames {
  return {
    deployment: `${slug}-pooler`,
    secret: `${slug}-pooler`,
    service: `${slug}-pooler`,
    upstream: `${slug}-pooler-upstream`,
    forwardSlice: `${slug}-pooler-upstream-fwd`,
  };
}

export function poolerHostOf(app: {
  slug: string;
  k8sNamespace: string;
}): string {
  return `${poolerNames(app.slug).service}.${app.k8sNamespace}.svc.cluster.local`;
}

/**
 * Never `flui-app-id`, never `app: <slug>`: those two labels mean "the database
 * pod" to pod exec, the tunnel, the replication Service and `<slug>-svc`. The
 * only link back to the database is `flui.cloud/pooler-of`.
 */
export function poolerLabels(app: {
  id: string;
  slug: string;
}): Record<string, string> {
  const name = poolerNames(app.slug).deployment;
  return {
    app: name,
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/instance': name,
    'app.kubernetes.io/component': 'pooler',
    'app.kubernetes.io/managed-by': 'flui-cloud',
    [POOLER_OF_LABEL]: app.id,
  };
}

/**
 * The Service PgBouncer dials and, in forward mode, the EndpointSlice that
 * points it at another cluster's database. Local mode selects the database pod
 * by `app: <slug>`: a database app runs a single pod and a standby is always a
 * separate app, so this and the role exec on `flui-app-id` reach the same pod.
 */
export function poolerUpstreamObjects(
  app: { id: string; slug: string; k8sNamespace: string },
  spec: Pick<PoolerSpec, 'upstream' | 'upstreamClusterIP'>,
): {
  service: Record<string, unknown>;
  slice: Record<string, unknown> | null;
} {
  const names = poolerNames(app.slug);
  const labels = poolerLabels(app);
  const forward = spec.upstream.mode === 'forward' ? spec.upstream : null;
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: names.upstream, namespace: app.k8sNamespace, labels },
    spec: {
      type: 'ClusterIP',
      ...(spec.upstreamClusterIP ? { clusterIP: spec.upstreamClusterIP } : {}),
      ...(forward ? {} : { selector: { app: app.slug } }),
      ports: [
        {
          name: 'postgres',
          port: 5432,
          targetPort: forward ? forward.port : 5432,
          protocol: 'TCP',
        },
      ],
    },
  };
  const slice = forward
    ? {
        apiVersion: 'discovery.k8s.io/v1',
        kind: 'EndpointSlice',
        metadata: {
          name: names.forwardSlice,
          namespace: app.k8sNamespace,
          labels: {
            ...labels,
            'kubernetes.io/service-name': names.upstream,
            'endpointslice.kubernetes.io/managed-by': 'flui-cloud',
          },
        },
        addressType: 'IPv4',
        endpoints: [
          { addresses: [forward.address], conditions: { ready: true } },
        ],
        ports: [{ name: 'postgres', port: forward.port, protocol: 'TCP' }],
      }
    : null;
  return { service, slice };
}

/**
 * The pooler objects a deploy may apply. While the pooler forwards, the
 * upstream Service and its slice belong to the migration's cut: a merge patch
 * would keep the live selector, the controller's slice would come back beside
 * the forward one, and sessions would split between the two databases.
 */
export function poolerManifestsToApply<T extends { name: string }>(
  app: { slug: string; pooler?: Pick<PoolerSpec, 'upstream'> | null },
  manifests: T[],
): T[] {
  if (app.pooler?.upstream?.mode !== 'forward') return manifests;
  const names = poolerNames(app.slug);
  return manifests.filter(
    (m) => m.name !== names.upstream && m.name !== names.forwardSlice,
  );
}

/**
 * The user and database a managed PostgreSQL was initialised with, read the
 * way the image reads them: `POSTGRES_DB` falls back to the user, the user to
 * `postgres`. A secret value is decrypted, and used as stored when it is not
 * encrypted after all.
 */
export function postgresIdentity(
  env:
    | ReadonlyArray<{
        name: string;
        value: string;
        secret?: boolean;
        pending?: boolean;
      }>
    | null
    | undefined,
  encryption: { decrypt(value: string): string },
): { user: string; database: string } {
  const read = (name: string): string | undefined => {
    const e = env?.find((v) => v.name === name && !v.pending);
    if (!e?.value) return undefined;
    if (!e.secret) return e.value;
    try {
      return encryption.decrypt(e.value);
    } catch {
      return e.value;
    }
  };
  const user = read('POSTGRES_USER') ?? 'postgres';
  return { user, database: read('POSTGRES_DB') ?? user };
}

const PGBOUNCER_NAME = /^\w[\w.-]*$/;

export function assertPgbouncerName(kind: string, value: string): string {
  if (!PGBOUNCER_NAME.test(value)) {
    throw new Error(
      `The ${kind} "${value}" cannot be written into the pooler configuration`,
    );
  }
  return value;
}

export function renderPgbouncerIni(facts: {
  database: string;
  upstreamHost: string;
  mode: PoolerMode;
}): string {
  const db = assertPgbouncerName('database name', facts.database);
  return [
    '[databases]',
    `${db} = host=${facts.upstreamHost} port=5432 dbname=${db} auth_dbname=${db}`,
    '',
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    `listen_port = ${POOLER_LISTEN_PORT}`,
    'unix_socket_dir =',
    `pool_mode = ${facts.mode}`,
    'max_client_conn = 1000',
    'default_pool_size = 20',
    'min_pool_size = 0',
    'reserve_pool_size = 0',
    'max_db_connections = 50',
    'server_reset_query = DISCARD ALL',
    'server_reset_query_always = 0',
    'max_prepared_statements = 200',
    `query_wait_timeout = ${POOLER_QUERY_WAIT_TIMEOUT_DEFAULT_S}`,
    `client_login_timeout = ${POOLER_LOGIN_TIMEOUT_DEFAULT_S}`,
    'server_login_retry = 1',
    'server_connect_timeout = 5',
    'application_name_add_host = 1',
    'ignore_startup_parameters = extra_float_digits',
    'auth_type = scram-sha-256',
    'auth_file = /etc/pgbouncer/userlist.txt',
    `auth_user = ${POOLER_ROLE}`,
    `auth_query = SELECT usename, passwd FROM ${POOLER_ROLE}.lookup($1)`,
    `admin_users = ${POOLER_ADMIN_USER}`,
    `stats_users = ${POOLER_ADMIN_USER}`,
    'client_tls_sslmode = disable',
    'server_tls_sslmode = prefer',
    'log_connections = 0',
    'log_disconnections = 0',
    '',
  ].join('\n');
}

const USERLIST_SAFE = /^[A-Za-z0-9_-]+$/;

export function renderUserlist(passwords: {
  auth: string;
  admin: string;
}): string {
  for (const p of [passwords.auth, passwords.admin]) {
    if (!USERLIST_SAFE.test(p)) {
      throw new Error(
        'A pooler password holds characters the user list cannot carry',
      );
    }
  }
  return (
    `"${POOLER_ROLE}" "${passwords.auth}"\n` +
    `"${POOLER_ADMIN_USER}" "${passwords.admin}"\n`
  );
}

export function poolerConfigHash(parts: string[]): string {
  return createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, 16);
}

export const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 secret PostgreSQL stores for a password, in the form
 * `ALTER ROLE … PASSWORD` accepts as already hashed (RFC 5802, RFC 7677).
 * The passwords given here are ASCII, so SASLprep leaves them unchanged.
 */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = SCRAM_ITERATIONS,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key: Buffer, msg: string) =>
    createHmac('sha256', key).update(msg).digest();
  const storedKey = createHash('sha256')
    .update(hmac(salted, 'Client Key'))
    .digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * The timeline a database writes on now. The last checkpoint's lags behind a
 * fast promote, so a primary reads it from its current WAL file name; a
 * standby, where that name cannot be asked for, falls back to the checkpoint.
 */
export const INSERT_TIMELINE_SQL =
  "CASE WHEN pg_is_in_recovery() THEN (SELECT k.timeline_id FROM pg_control_checkpoint() k) ELSE ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::int END";

/**
 * The role PgBouncer logs in as to look up a client's SCRAM secret, and the two
 * functions it may call. Run on the primary over the local socket; only the
 * SCRAM verifier of the password reaches the database, as a psql variable set
 * on stdin, never on a command line. Replication roles and the pooler's own
 * role are never handed out.
 */
export function ensurePoolerRoleScript(
  password: string,
  salt?: Buffer,
): string {
  if (!USERLIST_SAFE.test(password)) {
    throw new Error('A pooler password holds characters psql cannot carry');
  }
  const role = POOLER_ROLE;
  return [
    String.raw`\set pw '${scramSha256Verifier(password, salt)}'`,
    `DO $$ BEGIN
  IF pg_is_in_recovery() THEN
    RAISE EXCEPTION 'the database is a standby; the pooler role is set up on the primary';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 20;
  END IF;
END $$;`,
    `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 20 PASSWORD :'pw';`,
    `CREATE SCHEMA IF NOT EXISTS ${role};`,
    `CREATE OR REPLACE FUNCTION ${role}.lookup(p_user text)
  RETURNS TABLE (usename name, passwd text) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT rolname, CASE WHEN rolvaliduntil IS NULL OR rolvaliduntil > now() THEN rolpassword END
    FROM pg_authid WHERE rolname = p_user AND rolcanlogin AND (rolsuper OR NOT rolreplication) AND rolname <> '${role}' $$;`,
    `CREATE OR REPLACE FUNCTION ${role}.whoami()
  RETURNS TABLE (in_recovery boolean, system_identifier bigint, timeline_id integer, server_addr inet)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT pg_is_in_recovery(), (SELECT c.system_identifier FROM pg_control_system() c),
         ${INSERT_TIMELINE_SQL}, inet_server_addr() $$;`,
    `REVOKE ALL ON SCHEMA ${role} FROM PUBLIC;`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${role} FROM PUBLIC;`,
    `GRANT USAGE ON SCHEMA ${role} TO ${role};`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${role} TO ${role};`,
    '',
  ].join('\n');
}
