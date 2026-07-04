import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * app-migration: application migration machine state (plan §6 step 2). Dev uses
 * synchronize:true so this already exists there; brings prod to parity.
 * Idempotent.
 */
export class CreateAppMigrations1781700000000 implements MigrationInterface {
  name = 'CreateAppMigrations1781700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_migrations_status_enum') THEN
          CREATE TYPE "app_migrations_status_enum" AS ENUM
            ('pending', 'provisioning', 'ready', 'cutover', 'completed', 'failed', 'aborted');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_migrations_cutovermode_enum') THEN
          CREATE TYPE "app_migrations_cutovermode_enum" AS ENUM ('auto', 'manual');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_migrations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "srcAppId" uuid NOT NULL,
        "srcClusterId" uuid NOT NULL,
        "targetClusterId" uuid NOT NULL,
        "cutoverMode" "app_migrations_cutovermode_enum" NOT NULL DEFAULT 'auto',
        "status" "app_migrations_status_enum" NOT NULL DEFAULT 'pending',
        "infrastructureOperationId" uuid,
        "errorMessage" text,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_migrations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_app_migrations_src" ON "app_migrations" ("srcAppId")`,
    );
    await queryRunner.query(
      `ALTER TYPE "infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS 'migrate_application'`,
    );
    for (const step of [
      'app_migrate_provision_target',
      'app_migrate_ready',
      'app_migrate_cutover',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${step}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "app_migrations"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "app_migrations_status_enum"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "app_migrations_cutovermode_enum"`,
    );
  }
}
