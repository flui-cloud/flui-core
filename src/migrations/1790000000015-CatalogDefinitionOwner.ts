import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A catalog definition sent through `install-from-yaml` belongs to the user who
 * sent it; the shared catalog (owner null) is written only by the seed files.
 * Every existing row stays shared: nothing recorded which ones came from a
 * user's manifest. (slug, version) stays unique within the shared catalog and
 * within each owner, so a private row may reuse a version number.
 */
export class CatalogDefinitionOwner1790000000015 implements MigrationInterface {
  name = 'CatalogDefinitionOwner1790000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "catalog_app_definitions" ADD COLUMN IF NOT EXISTS "ownerUserId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "catalog_app_definitions" DROP CONSTRAINT IF EXISTS "UQ_2d1fdde6d0857f5f29b1494d0c8"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_catalog_app_definitions_shared_slug_version" ON "catalog_app_definitions" ("slug", "version") WHERE "ownerUserId" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_catalog_app_definitions_owned_slug_version" ON "catalog_app_definitions" ("ownerUserId", "slug", "version") WHERE "ownerUserId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_catalog_app_definitions_owned_slug_version"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_catalog_app_definitions_shared_slug_version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "catalog_app_definitions" ADD CONSTRAINT "UQ_2d1fdde6d0857f5f29b1494d0c8" UNIQUE ("slug", "version")`,
    );
    await queryRunner.query(
      `ALTER TABLE "catalog_app_definitions" DROP COLUMN IF EXISTS "ownerUserId"`,
    );
  }
}
