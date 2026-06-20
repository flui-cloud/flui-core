/**
 * The slice of per-engine DB facts the CLI needs (the backend owns the full
 * EngineProfile; this mirrors only scheme/secret-key/port/client for tunnel +
 * credentials). The `engine` comes from the API's connection-info response.
 */
export interface CliEngineProfile {
  label: string;
  /** Candidate keys holding the owner password in `${slug}-secret` (first present wins). */
  secretPasswordKeys: string[];
  /** Scheme for a DATABASE_URL / connection string. */
  urlScheme: string;
  /** Default local port for `flui db tunnel`. */
  defaultLocalPort: number;
  /** Builds a one-line native-client invocation against a local tunnel. */
  clientHint(
    user: string,
    database: string,
    port: number,
    password: string,
  ): string;
}

const PROFILES: Record<string, CliEngineProfile> = {
  postgres: {
    label: 'PostgreSQL',
    secretPasswordKeys: ['POSTGRES_PASSWORD'],
    urlScheme: 'postgresql',
    defaultLocalPort: 55432,
    clientHint: (user, database, port, password) =>
      `PGPASSWORD='${password}' psql -h 127.0.0.1 -p ${port} -U ${user} -d ${database}`,
  },
  mariadb: {
    label: 'MariaDB',
    // MariaDB accepts MARIADB_* and legacy MYSQL_* aliases — the secret carries whichever the seed used.
    secretPasswordKeys: ['MARIADB_PASSWORD', 'MYSQL_PASSWORD'],
    urlScheme: 'mysql',
    defaultLocalPort: 53306,
    clientHint: (user, database, port, password) =>
      `mariadb -h 127.0.0.1 -P ${port} -u ${user} -p'${password}' ${database}`,
  },
  valkey: {
    label: 'Valkey',
    secretPasswordKeys: ['VALKEY_PASSWORD'],
    urlScheme: 'redis',
    defaultLocalPort: 56379,
    // Redis/Valkey auth with the password only — user/database are unused.
    clientHint: (_user, _database, port, password) =>
      `redis-cli -h 127.0.0.1 -p ${port} -a '${password}'`,
  },
  redis: {
    label: 'Redis',
    secretPasswordKeys: ['REDIS_PASSWORD'],
    urlScheme: 'redis',
    defaultLocalPort: 56379,
    clientHint: (_user, _database, port, password) =>
      `redis-cli -h 127.0.0.1 -p ${port} -a '${password}'`,
  },
  ferretdb: {
    label: 'FerretDB',
    // FerretDB v1 (auth: none) connects anonymously; the keys cover a future authenticated store.
    secretPasswordKeys: [
      'FERRETDB_PASSWORD',
      'MONGODB_PASSWORD',
      'MONGO_PASSWORD',
    ],
    urlScheme: 'mongodb',
    defaultLocalPort: 57017,
    clientHint: (user, _database, port, password) =>
      password
        ? `mongosh "mongodb://${user || 'admin'}:${password}@127.0.0.1:${port}/?authSource=admin"`
        : `mongosh "mongodb://127.0.0.1:${port}"`,
  },
};

const FALLBACK = PROFILES.postgres;

export function engineProfile(engine: string | undefined): CliEngineProfile {
  return (engine && PROFILES[engine]) || FALLBACK;
}
