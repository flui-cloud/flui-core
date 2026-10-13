import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A visitor turning into an account. The visitor row now outlives a visitor
 * merged into an existing account, as the record of where it went and so its
 * identity can never come back as a new person; `linkedUserId` points at that
 * account. The single-use handles of the sign-in under way get a table of
 * their own. Constraint names are TypeORM's own, so a development
 * `synchronize` finds nothing to change, and every statement can run twice.
 * `down()` deletes the history rows of visitors merged into an account: the
 * cascade it restores cannot hold a row whose person is gone.
 */
export class SandboxVisitorUpgrades1790000000036 implements MigrationInterface {
  name = 'SandboxVisitorUpgrades1790000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitors" DROP CONSTRAINT IF EXISTS "FK_d1c8fde693070ee4286565f3b29"`,
    );
    await queryRunner.query(
      `UPDATE "sandbox_visitors" v SET "linkedUserId" = NULL WHERE "linkedUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = v."linkedUserId")`,
    );
    await queryRunner.query(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_c96495d16f902e292d57b4055c9') THEN
          ALTER TABLE "sandbox_visitors" ADD CONSTRAINT "FK_c96495d16f902e292d57b4055c9" FOREIGN KEY ("linkedUserId") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END $$`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sandbox_visitors_linked_user" ON "sandbox_visitors" ("linkedUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sandbox_visitors_idp_user" ON "sandbox_visitors" ("idpUserId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sandbox_visitor_upgrades" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "visitorUserId" uuid NOT NULL,
        "method" character varying(8) NOT NULL,
        "provider" character varying(16),
        "idpId" character varying(64),
        "intentId" character varying(128),
        "intentTokenEncrypted" text,
        "secretHash" character varying(64),
        "returnTo" character varying(512),
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "claimedAt" TIMESTAMP WITH TIME ZONE,
        "outcome" character varying(24),
        "linkedUserId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_1dff6fe47aa9801b352e7fca7b9" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sandbox_visitor_upgrades_secret" ON "sandbox_visitor_upgrades" ("secretHash") WHERE "secretHash" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sandbox_visitor_upgrades_intent" ON "sandbox_visitor_upgrades" ("intentId") WHERE "intentId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sandbox_visitor_upgrades_expires" ON "sandbox_visitor_upgrades" ("expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sandbox_visitor_upgrades"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_sandbox_visitors_idp_user"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_sandbox_visitors_linked_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitors" DROP CONSTRAINT IF EXISTS "FK_c96495d16f902e292d57b4055c9"`,
    );
    await queryRunner.query(
      `DELETE FROM "sandbox_visitors" v WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = v."userId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_visitors" ADD CONSTRAINT "FK_d1c8fde693070ee4286565f3b29" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE`,
    );
  }
}
