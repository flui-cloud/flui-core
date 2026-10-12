import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrationMeasures1790000000029 implements MigrationInterface {
  name = 'MigrationMeasures1790000000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "db_migrations" ADD COLUMN IF NOT EXISTS "writesStoppedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" ADD COLUMN IF NOT EXISTS "promoteConfirmedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" ADD COLUMN IF NOT EXISTS "writePauseMs" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "full_migrations" ADD COLUMN IF NOT EXISTS "writePauseMs" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "full_migrations" ADD COLUMN IF NOT EXISTS "writePauseEndedBy" character varying(8)`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" ADD COLUMN IF NOT EXISTS "interruptionMs" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" ADD COLUMN IF NOT EXISTS "dnsFlippedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_migrations" DROP COLUMN IF EXISTS "dnsFlippedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" DROP COLUMN IF EXISTS "interruptionMs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "full_migrations" DROP COLUMN IF EXISTS "writePauseEndedBy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "full_migrations" DROP COLUMN IF EXISTS "writePauseMs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" DROP COLUMN IF EXISTS "writePauseMs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" DROP COLUMN IF EXISTS "promoteConfirmedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "db_migrations" DROP COLUMN IF EXISTS "writesStoppedAt"`,
    );
  }
}
