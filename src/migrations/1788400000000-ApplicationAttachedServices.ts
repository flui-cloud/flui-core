import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What an application attached to itself in `deploy.services[]`, and what became
 * of it.
 *
 * A table and not a key in `applications.metadata`: the source deploy merges
 * metadata blindly on every push, so a record kept there would be dropped by
 * the next writer, and the orphan sweep needs an index that a JSON blob cannot
 * give.
 *
 * Two unique indexes carry the safety, in the database rather than in a code
 * path that two API replicas would each run their own copy of:
 *   - (applicationId, name) among live rows — two simultaneous pushes of the
 *     same branch both arrive at the upsert, and only one row may result;
 *   - catalogInstallId — no two applications may ever claim one Postgres
 *     (NULL rows stay distinct, so a service not yet provisioned is free).
 *
 * `scope` exists with only one legal value, `app`. The manifest spec has no
 * `scope` field, so nothing can write anything else; the column is here because
 * adding a discriminator to rows that already exist is the expensive half, and
 * no code branches on it today.
 *
 * Additive only: nothing on an existing table is altered.
 */
export class ApplicationAttachedServices1788400000000
  implements MigrationInterface
{
  name = 'ApplicationAttachedServices1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "application_services" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "applicationId" uuid NOT NULL,
        "name" character varying(32) NOT NULL,
        "block" character varying(64) NOT NULL,
        "scope" character varying(16) NOT NULL DEFAULT 'app',
        "catalogInstallId" uuid,
        "bbApplicationId" uuid,
        "status" character varying(16) NOT NULL DEFAULT 'PENDING',
        "statusReason" text,
        "envSpec" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "resources" jsonb,
        "desiredHash" character varying(64) NOT NULL DEFAULT '',
        "appliedHash" character varying(64),
        "lockToken" uuid,
        "lockExpiresAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_application_services" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_application_services_app_name" ` +
        `ON "application_services" ("applicationId", "name") WHERE "deletedAt" IS NULL`,
    );
    // Not partial, though only non-null rows can collide: Postgres already
    // treats NULLs as distinct in a unique index, and a predicate here that the
    // entity does not carry is drift a `synchronize` boot would try to correct
    // by dropping and rebuilding the index.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_application_services_install" ` +
        `ON "application_services" ("catalogInstallId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_application_services_app" ON "application_services" ("applicationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_application_services_status" ON "application_services" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_application_services_block_app" ON "application_services" ("bbApplicationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_application_services_block_app"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_application_services_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_application_services_app"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_application_services_install"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_application_services_app_name"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "application_services"`);
  }
}
