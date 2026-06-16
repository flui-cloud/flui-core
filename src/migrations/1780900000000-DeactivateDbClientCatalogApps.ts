import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire the standalone db-client catalog apps (superseded by the native database console).
 * Their seed files are gone, but the seeder never prunes disappeared slugs, so this one-off
 * deactivates the rows — not a hard delete, to keep FK integrity with historical installs.
 */
export class DeactivateDbClientCatalogApps1780900000000
  implements MigrationInterface
{
  name = 'DeactivateDbClientCatalogApps1780900000000';

  private static readonly SLUGS = [
    'pgweb',
    'phpmyadmin',
    'mongo-express',
    'redis-commander',
    'dbgate',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "catalog_app_definitions"
         SET "isActive" = false, "isPublished" = false
       WHERE "slug" = ANY($1)`,
      [DeactivateDbClientCatalogApps1780900000000.SLUGS],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort rollback: re-activate whatever rows still live in the DB.
    await queryRunner.query(
      `UPDATE "catalog_app_definitions"
         SET "isActive" = true, "isPublished" = true
       WHERE "slug" = ANY($1)`,
      [DeactivateDbClientCatalogApps1780900000000.SLUGS],
    );
  }
}
