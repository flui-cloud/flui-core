import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-app pod/container security settings (nullable JSON; null rows render no securityContext). */
export class AddSecurityContextToApplications1781000000000
  implements MigrationInterface
{
  name = 'AddSecurityContextToApplications1781000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "securityContext" json NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "securityContext"`,
    );
  }
}
