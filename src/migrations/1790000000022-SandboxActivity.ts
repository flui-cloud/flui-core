import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the demo needs to judge time by use instead of by the clock alone, and
 * to answer for the people in it: when a guest last did something in their
 * area and whether they were warned before it goes, when a person was last
 * seen and whether an administrator blocked them, and who is waiting for a
 * space. Every column is null on existing rows.
 */
export class SandboxActivity1790000000022 implements MigrationInterface {
  name = 'SandboxActivity1790000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" ADD COLUMN IF NOT EXISTS "expiryWarnedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "blockedReason" text`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sandbox_waitlist" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "email" character varying(255),
        "offeredAt" TIMESTAMP WITH TIME ZONE,
        "offerExpiresAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sandbox_waitlist" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sandbox_waitlist_user" UNIQUE ("userId")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sandbox_waitlist"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "blockedReason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "blockedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "lastSeenAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" DROP COLUMN IF EXISTS "expiryWarnedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" DROP COLUMN IF EXISTS "lastActiveAt"`,
    );
  }
}
