import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * full-migration: full-app migration orchestrator state (MVP-5c) + the
 * fullMigrationId/provisionOverrides columns on the child machines. Dev uses
 * synchronize:true so these already exist there; brings prod to parity.
 * Idempotent.
 */
export class CreateFullMigrations1781800000000 implements MigrationInterface {
  name = 'CreateFullMigrations1781800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'full_migrations_status_enum') THEN
          CREATE TYPE "full_migrations_status_enum" AS ENUM
            ('pending', 'db_replicating', 'app_staging', 'ready', 'cutover', 'completed', 'failed', 'failed_forward', 'aborted');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'full_migrations_cutovermode_enum') THEN
          CREATE TYPE "full_migrations_cutovermode_enum" AS ENUM ('auto', 'manual');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'full_migrations_stagingmode_enum') THEN
          CREATE TYPE "full_migrations_stagingmode_enum" AS ENUM ('scaled-down', 'live-fenced');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "full_migrations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "appId" uuid NOT NULL,
        "dbAppId" uuid NOT NULL,
        "targetClusterId" uuid NOT NULL,
        "cutoverMode" "full_migrations_cutovermode_enum" NOT NULL DEFAULT 'auto',
        "stagingMode" "full_migrations_stagingmode_enum" NOT NULL DEFAULT 'scaled-down',
        "status" "full_migrations_status_enum" NOT NULL DEFAULT 'pending',
        "dbMigrationId" uuid,
        "appMigrationId" uuid,
        "rewirePlan" jsonb,
        "infrastructureOperationId" uuid,
        "errorMessage" text,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_full_migrations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_full_migrations_app" ON "full_migrations" ("appId")`,
    );

    // Child-leg columns
    await queryRunner.query(
      `ALTER TABLE "app_migrations" ADD COLUMN IF NOT EXISTS "provisionOverrides" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" ADD COLUMN IF NOT EXISTS "fullMigrationId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" ADD COLUMN IF NOT EXISTS "fullMigrationId" uuid`,
    );

    // Operation type + steps
    await queryRunner.query(
      `ALTER TYPE "infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS 'migrate_full_app'`,
    );
    for (const step of [
      'full_migrate_db_replicate',
      'full_migrate_app_stage',
      'full_migrate_ready',
      'full_migrate_db_cutover',
      'full_migrate_rewire',
      'full_migrate_app_start',
      'full_migrate_dns_cutover',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${step}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "full_migrations"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "full_migrations_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "full_migrations_cutovermode_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "full_migrations_stagingmode_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" DROP COLUMN IF EXISTS "provisionOverrides"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" DROP COLUMN IF EXISTS "fullMigrationId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" DROP COLUMN IF EXISTS "fullMigrationId"`,
    );
  }
}
