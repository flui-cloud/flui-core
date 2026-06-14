export type DbEngine = 'postgres' | 'mariadb' | 'redis' | 'valkey';

export type DbConnectionRole = 'owner' | 'user';

/** Where the in-cluster database pod lives, so the transport can tunnel to it. */
export interface DbConnectionTarget {
  clusterId: string;
  namespace: string;
  podLabelSelector: string;
  port: number;
}

export interface DbCredentials {
  /**
   * Optional: SQL engines always carry it; key-value caches (Redis/Valkey) are frequently
   * deployed without auth (e.g. bundled catalog caches), so it may be absent — connect anonymously.
   */
  password?: string;
  /** SQL engines only; key-value engines authenticate with the password alone. */
  user?: string;
  database?: string;
}

export interface ResolvedDbConnection {
  engine: DbEngine;
  role: DbConnectionRole;
  target: DbConnectionTarget;
  credentials: DbCredentials;
}

export interface DbConnectionResolveInput {
  dbInstallId: string;
  fluiUserId: string;
}

/**
 * The seam that keeps the door open for per-user dedicated DB roles.
 * MVP impl resolves the building-block owner Secret (role: 'owner'); a future
 * DedicatedUserConnectionResolver will return a per-Flui-user role (role: 'user')
 * without any change to the query/transport layers above it.
 */
export interface DbConnectionResolver {
  resolve(input: DbConnectionResolveInput): Promise<ResolvedDbConnection>;
}

export const DB_CONNECTION_RESOLVER = Symbol('DB_CONNECTION_RESOLVER');

/**
 * NON-SECRET connection coordinates surfaced to the dashboard/CLI so they can reach the
 * DB. The password is deliberately NOT here: it never travels over the HTTP API. The CLI
 * reads it straight from the in-cluster Secret over SSH (see `flui db credentials`).
 */
export interface DbConnectionInfo {
  engine: DbEngine;
  database: string;
  user: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
}

/**
 * Future extension point (NOT implemented in the MVP): provisions/rotates a
 * dedicated Postgres role for a Flui user. The DedicatedUserConnectionResolver
 * will depend on this; the owner-Secret MVP does not.
 */
export interface DbRoleProvisioner {
  ensureUserRole(input: DbConnectionResolveInput): Promise<DbCredentials>;
}

export const DB_ROLE_PROVISIONER = Symbol('DB_ROLE_PROVISIONER');
