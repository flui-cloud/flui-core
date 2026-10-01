import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A person's decision that an application is not backed up: who, when and why.
 * Null on every existing row, so every application keeps being asked for.
 */
export class ApplicationBackupDecision1790000000019
  implements MigrationInterface
{
  name = 'ApplicationBackupDecision1790000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "backupDecision" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "backupDecision"`,
    );
  }
}
