import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * db-lifecycle: database migration machine state (plan §6 inner core). Dev uses
 * synchronize:true so this already exists there; brings prod to parity.
 * Idempotent.
 */
export class CreateDbMigrations1781600000000 implements MigrationInterface {
  name = 'CreateDbMigrations1781600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'db_migrations_status_enum') THEN
          CREATE TYPE "db_migrations_status_enum" AS ENUM
            ('pending', 'provisioning', 'replicating', 'synced', 'cutover', 'restoring', 'completed', 'failed', 'aborted');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'db_migrations_mode_enum') THEN
          CREATE TYPE "db_migrations_mode_enum" AS ENUM ('live', 'restore');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'db_migrations_cutovermode_enum') THEN
          CREATE TYPE "db_migrations_cutovermode_enum" AS ENUM ('auto', 'manual');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "db_migrations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "srcAppId" uuid NOT NULL,
        "targetClusterId" uuid NOT NULL,
        "displayName" character varying(120) NOT NULL,
        "mode" "db_migrations_mode_enum" NOT NULL DEFAULT 'live',
        "cutoverMode" "db_migrations_cutovermode_enum" NOT NULL DEFAULT 'auto',
        "verifyRowCounts" boolean NOT NULL DEFAULT true,
        "recoveryTargetTime" TIMESTAMP WITH TIME ZONE,
        "status" "db_migrations_status_enum" NOT NULL DEFAULT 'pending',
        "dstInstallId" uuid,
        "dstAppId" uuid,
        "linkId" uuid,
        "restoreJobId" uuid,
        "infrastructureOperationId" uuid,
        "verifySummary" jsonb,
        "errorMessage" text,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_db_migrations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_db_migrations_src" ON "db_migrations" ("srcAppId")`,
    );
    await queryRunner.query(
      `ALTER TYPE "infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS 'migrate_database'`,
    );
    for (const step of [
      'db_migrate_provision_target',
      'db_migrate_replicate',
      'db_migrate_synced',
      'db_migrate_cutover',
      'db_migrate_restore',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${step}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "db_migrations"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "db_migrations_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "db_migrations_mode_enum"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "db_migrations_cutovermode_enum"`,
    );
  }
}
