import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Database PITR restore: new enum values (targetKind=database, strategy=pg_pitr)
 * and a recoveryTargetTime column on restore_jobs. Dev uses synchronize:true so
 * these already exist there; this brings prod to parity. All statements idempotent.
 * ADD VALUE ... IF NOT EXISTS is safe in a tx on PG12+ as long as the value is
 * not used in the same migration (it is not).
 */
export class AddDbRestoreColumns1781400000000 implements MigrationInterface {
  name = 'AddDbRestoreColumns1781400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "restore_jobs_targetkind_enum" ADD VALUE IF NOT EXISTS 'database'`,
    );
    await queryRunner.query(
      `ALTER TYPE "restore_jobs_strategy_enum" ADD VALUE IF NOT EXISTS 'pg_pitr'`,
    );
    await queryRunner.query(
      `ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "recoveryTargetTime" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Enum values are not dropped (Postgres has no ADD-VALUE inverse; harmless).
    await queryRunner.query(
      `ALTER TABLE "restore_jobs" DROP COLUMN IF EXISTS "recoveryTargetTime"`,
    );
  }
}
