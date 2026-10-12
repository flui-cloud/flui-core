import { MigrationInterface, QueryRunner } from 'typeorm';

export class FullMigrationBackupDestination1790000000026
  implements MigrationInterface
{
  name = 'FullMigrationBackupDestination1790000000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "full_migrations" ADD COLUMN IF NOT EXISTS "backupDestinationId" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "full_migrations" DROP COLUMN IF EXISTS "backupDestinationId"`,
    );
  }
}
