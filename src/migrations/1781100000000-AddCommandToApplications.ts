import { MigrationInterface, QueryRunner } from 'typeorm';

/** Exec-form entrypoint override (nullable JSON string[]); null rows render no command override. */
export class AddCommandToApplications1781100000000
  implements MigrationInterface
{
  name = 'AddCommandToApplications1781100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "command" json NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "command"`,
    );
  }
}
