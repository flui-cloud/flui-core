import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The pooler side of a database migration's cutover: which poolers were
 * paused, when, until when, and who was cut at the deadline. NULL on every
 * migration that ran without one.
 */
export class DbPoolerCut1790000000032 implements MigrationInterface {
  name = 'DbPoolerCut1790000000032';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "db_migrations" ADD COLUMN IF NOT EXISTS "poolerCut" jsonb`,
    );
    for (const step of [
      'full_migrate_pooler_forward',
      'db_migrate_pooler_pause',
      'db_migrate_pooler_resume',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${step}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "db_migrations" DROP COLUMN IF EXISTS "poolerCut"`,
    );
  }
}
