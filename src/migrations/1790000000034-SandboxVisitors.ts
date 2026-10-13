import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Visitors of the demo who have not signed in: a `kind` on every person, and
 * one row per visitor for what only a visitor has. Constraint names are
 * TypeORM's own, so a development `synchronize` finds nothing to change.
 */
export class SandboxVisitors1790000000034 implements MigrationInterface {
  name = 'SandboxVisitors1790000000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kind" character varying(16) NOT NULL DEFAULT 'person'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_kind_last_seen" ON "users" ("kind", "lastSeenAt")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sandbox_visitors" (
        "userId" uuid NOT NULL,
        "idpUserId" character varying(64) NOT NULL,
        "ipHash" character varying(128),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "upgradedAt" TIMESTAMP WITH TIME ZONE,
        "linkedUserId" uuid,
        CONSTRAINT "PK_d1c8fde693070ee4286565f3b29" PRIMARY KEY ("userId"),
        CONSTRAINT "FK_d1c8fde693070ee4286565f3b29" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sandbox_visitors"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_kind_last_seen"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "kind"`);
  }
}
