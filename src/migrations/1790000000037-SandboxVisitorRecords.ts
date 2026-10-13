import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Visitors who left keep their row, marked `removedAt`, so a token issued
 * before they were removed can never make them again as a new person. The
 * login-client credential gets an expiry and the id it is deleted by. Refused
 * visitors are counted per hour and reason. Pool rows already taken are only
 * a record nobody reads, and go.
 */
export class SandboxVisitorRecords1790000000037 implements MigrationInterface {
  name = 'SandboxVisitorRecords1790000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitors" ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sandbox_visitors_created" ON "sandbox_visitors" ("createdAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitor_login_client" ADD COLUMN IF NOT EXISTS "tokenId" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitor_login_client" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sandbox_visitor_refusals" (
        "hour" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reason" character varying(24) NOT NULL,
        "count" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_sandbox_visitor_refusals" PRIMARY KEY ("hour", "reason")
      )`,
    );
    await queryRunner.query(
      `DELETE FROM "sandbox_visitor_pool" WHERE "takenAt" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sandbox_visitor_refusals"`);
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitor_login_client" DROP COLUMN IF EXISTS "expiresAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitor_login_client" DROP COLUMN IF EXISTS "tokenId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_sandbox_visitors_created"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitors" DROP COLUMN IF EXISTS "removedAt"`,
    );
  }
}
