import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A demo area no longer carries an identity: it is a project and its fenced
 * namespace, built ahead and handed to a guest at their first deploy. The
 * guest's email is written then, not at build time, and the area remembers
 * which project it is.
 */
export class SandboxAreas1790000000021 implements MigrationInterface {
  name = 'SandboxAreas1790000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" ALTER COLUMN "email" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" ADD COLUMN IF NOT EXISTS "projectId" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" DROP COLUMN IF EXISTS "projectId"`,
    );
    await queryRunner.query(
      `UPDATE "sandbox_tenants" SET "email" = '' WHERE "email" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" ALTER COLUMN "email" SET NOT NULL`,
    );
  }
}
