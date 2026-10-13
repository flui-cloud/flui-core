import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The visitors' entrance: visitors made ahead of time, single-use admission
 * tickets, and the login-client credential. Constraint names are TypeORM's
 * own, so a development `synchronize` finds nothing to change.
 */
export class SandboxVisitorEntrance1790000000035 implements MigrationInterface {
  name = 'SandboxVisitorEntrance1790000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sandbox_visitor_pool" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "idpUserId" character varying(64) NOT NULL,
        "sessionId" character varying(128) NOT NULL,
        "sessionTokenEncrypted" text NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "takenAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_0a32134913b8ff7a6048344d135" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sandbox_visitor_pool_taken_created" ON "sandbox_visitor_pool" ("takenAt", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sandbox_visitor_admissions" (
        "nonceHash" character varying(64) NOT NULL,
        "ipHash" character varying(128) NOT NULL,
        "cli" boolean NOT NULL DEFAULT false,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_4c6a19499ecc32533c2a2bad91c" PRIMARY KEY ("nonceHash")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sandbox_visitor_admissions_expires" ON "sandbox_visitor_admissions" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sandbox_visitor_login_client" (
        "id" character varying(32) NOT NULL,
        "idpUserId" character varying(64) NOT NULL,
        "patEncrypted" text NOT NULL,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_fe0d82c34b2194e79915d54836c" PRIMARY KEY ("id")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "sandbox_visitor_login_client"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "sandbox_visitor_admissions"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "sandbox_visitor_pool"`);
  }
}
