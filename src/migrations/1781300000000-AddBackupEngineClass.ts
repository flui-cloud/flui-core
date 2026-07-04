import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Database-class backups: engineClass on policies + artifacts, and a pgBackRest
 * backup label (engineRef) on artifacts whose backups have no Velero CR. Dev uses
 * synchronize:true so these already exist there; this brings prod to parity. All
 * statements are idempotent.
 */
export class AddBackupEngineClass1781300000000 implements MigrationInterface {
  name = 'AddBackupEngineClass1781300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'backup_policies_engineclass_enum') THEN
          CREATE TYPE "backup_policies_engineclass_enum" AS ENUM ('volume', 'database');
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "engineClass" "backup_policies_engineclass_enum" NOT NULL DEFAULT 'volume'`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'backup_artifacts_engineclass_enum') THEN
          CREATE TYPE "backup_artifacts_engineclass_enum" AS ENUM ('volume', 'database');
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ADD COLUMN IF NOT EXISTS "engineClass" "backup_artifacts_engineclass_enum" NOT NULL DEFAULT 'volume'`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ADD COLUMN IF NOT EXISTS "engineRef" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ALTER COLUMN "veleroBackupName" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" DROP COLUMN IF EXISTS "engineRef"`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" DROP COLUMN IF EXISTS "engineClass"`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_policies" DROP COLUMN IF EXISTS "engineClass"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "backup_artifacts_engineclass_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "backup_policies_engineclass_enum"`,
    );
  }
}
