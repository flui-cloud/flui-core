import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { migrations } from '../migrations';
import { API_APPLICATION_NAME } from '../common/instance/api-instance';

/** Flui's own advisory keyspace, then "migrations". */
const MIGRATION_LOCK: [number, number] = [0x464c5549, 2];

export const boolOr = (raw: string | undefined, fallback: boolean): boolean =>
  raw === undefined || raw === null || raw === ''
    ? fallback
    : raw.toLowerCase() === 'true';

export const migrationsWanted = (): boolean =>
  boolOr(process.env.DB_MIGRATIONS_RUN, process.env.NODE_ENV === 'production');

/**
 * Applies pending migrations before the API starts, one copy at a time.
 *
 * TypeORM takes no lock of its own: two copies booting together would both
 * run a migration, one failing on its DDL or a data migration applying twice.
 * Here a copy waits for the others, then finds nothing left to do. Returns
 * whether it ran them, so the application's own connection does not repeat it.
 */
export async function runMigrationsOnce(): Promise<boolean> {
  if (!migrationsWanted()) return false;
  const logger = new Logger('Migrations');
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number.parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'developer',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'myapp_dev',
    extra: {
      options: '-c timezone=UTC',
      application_name: API_APPLICATION_NAME,
    },
    migrations,
    migrationsTransactionMode: 'all',
  });
  await dataSource.initialize();
  const lock = dataSource.createQueryRunner();
  try {
    await lock.connect();
    await lock.query('SELECT pg_advisory_lock($1, $2)', MIGRATION_LOCK);
    try {
      const applied = await dataSource.runMigrations();
      logger.log(
        applied.length > 0
          ? `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`
          : 'The database schema is up to date',
      );
    } finally {
      await lock
        .query('SELECT pg_advisory_unlock($1, $2)', MIGRATION_LOCK)
        .catch(() => undefined);
    }
  } finally {
    await lock.release().catch(() => undefined);
    await dataSource.destroy();
  }
  return true;
}
