import { DbEngine } from '../interfaces/db-connection';

/**
 * Engine family — drives which capability + console serves the engine. 'sql' uses the
 * SqlEngineAdapter (query/schema); 'keyvalue' (Redis/Valkey) uses the KeyValueEngineAdapter
 * (keyspace browse + command). A future MongoDB would add 'document'. Routing is by family,
 * never by engine name.
 */
export type DbEngineFamily = 'sql' | 'keyvalue';

/**
 * The single source of truth for everything that differs between supported
 * engines. Adding an engine = one entry here + one adapter + one KB corpus; the
 * query/transport/assist layers stay engine-agnostic. The CLI and dashboard
 * mirror only the small subset they need (scheme/secret-key/clients).
 */
export interface EngineProfile {
  engine: DbEngine;
  /** Relational vs (future) document/key-value — drives which console can serve it. */
  family: DbEngineFamily;
  /** Human label used in copilot version binding and UI. */
  label: string;
  /** KB folder + dialect tag (`postgres` | `mysql`). */
  dialect: string;
  /** In-cluster service port. */
  defaultPort: number;
  /** Scheme for a DATABASE_URL / connection string. */
  urlScheme: string;
  /** Candidate keys holding the owner password in `${slug}-secret` (first present wins). */
  secretPasswordKeys: string[];
  /** Candidate env var names carrying the owner user (first present wins). */
  envUserKeys: string[];
  /** Candidate env var names carrying the default database. */
  envDatabaseKeys: string[];
  /** Matches the building-block image so the engine can be inferred from it. */
  imagePattern: RegExp;
}

export const ENGINE_PROFILES: Record<DbEngine, EngineProfile> = {
  postgres: {
    engine: 'postgres',
    family: 'sql',
    label: 'PostgreSQL',
    dialect: 'postgres',
    defaultPort: 5432,
    urlScheme: 'postgresql',
    secretPasswordKeys: ['POSTGRES_PASSWORD'],
    envUserKeys: ['POSTGRES_USER'],
    envDatabaseKeys: ['POSTGRES_DB'],
    imagePattern: /postgres/i,
  },
  mariadb: {
    engine: 'mariadb',
    family: 'sql',
    label: 'MariaDB',
    dialect: 'mysql',
    defaultPort: 3306,
    urlScheme: 'mysql',
    // MariaDB images accept the MARIADB_* names and the legacy MYSQL_* aliases (the generated
    // secret carries whichever the seed used — e.g. nextcloud uses MYSQL_PASSWORD).
    secretPasswordKeys: ['MARIADB_PASSWORD', 'MYSQL_PASSWORD'],
    envUserKeys: ['MARIADB_USER', 'MYSQL_USER'],
    envDatabaseKeys: ['MARIADB_DATABASE', 'MYSQL_DATABASE'],
    imagePattern: /maria|mysql/i,
  },
  valkey: {
    engine: 'valkey',
    family: 'keyvalue',
    label: 'Valkey',
    dialect: 'redis',
    defaultPort: 6379,
    urlScheme: 'redis',
    secretPasswordKeys: ['VALKEY_PASSWORD'],
    // Key-value engines authenticate with the password only — no user/database env.
    envUserKeys: [],
    envDatabaseKeys: [],
    imagePattern: /valkey/i,
  },
  redis: {
    engine: 'redis',
    family: 'keyvalue',
    label: 'Redis',
    dialect: 'redis',
    defaultPort: 6379,
    urlScheme: 'redis',
    secretPasswordKeys: ['REDIS_PASSWORD'],
    envUserKeys: [],
    envDatabaseKeys: [],
    imagePattern: /redis/i,
  },
};

export function profileForEngine(engine: DbEngine): EngineProfile {
  return ENGINE_PROFILES[engine];
}

export function detectEngineFromImage(imageRef?: string): DbEngine | null {
  if (!imageRef) return null;
  // Order matters: valkey before redis (its image is valkey/valkey, not redis); the rest
  // have unambiguous patterns.
  for (const profile of [
    ENGINE_PROFILES.postgres,
    ENGINE_PROFILES.mariadb,
    ENGINE_PROFILES.valkey,
    ENGINE_PROFILES.redis,
  ]) {
    if (profile.imagePattern.test(imageRef)) return profile.engine;
  }
  return null;
}
