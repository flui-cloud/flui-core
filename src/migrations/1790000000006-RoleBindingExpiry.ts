import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A grant can end on its own. Existing grants stay standing (null expiry) and
 * carry no record of who made them.
 */
export class RoleBindingExpiry1790000000006 implements MigrationInterface {
  name = 'RoleBindingExpiry1790000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "iam_role_bindings" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "iam_role_bindings" ADD COLUMN IF NOT EXISTS "grantedBy" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "iam_role_bindings" ADD COLUMN IF NOT EXISTS "expiringNoticeAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "iam_role_bindings" ADD COLUMN IF NOT EXISTS "expiredNoticeAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "iam_role_bindings" DROP COLUMN IF EXISTS "expiredNoticeAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "iam_role_bindings" DROP COLUMN IF EXISTS "expiringNoticeAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "iam_role_bindings" DROP COLUMN IF EXISTS "grantedBy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "iam_role_bindings" DROP COLUMN IF EXISTS "expiresAt"`,
    );
  }
}
