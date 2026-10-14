import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Whether the identity provider's console is open, until when, who opened it
 * and why. No row means closed.
 */
export class IdentityConsoleState1790000000040 implements MigrationInterface {
  name = 'IdentityConsoleState1790000000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "identity_console_state" ("id" character varying(16) NOT NULL, "openUntil" TIMESTAMP WITH TIME ZONE, "openedAt" TIMESTAMP WITH TIME ZONE, "openedByUserId" character varying(64), "openedByEmail" character varying(320), "reason" character varying(500), "closedAt" TIMESTAMP WITH TIME ZONE, "appliedState" character varying(16), "appliedHosts" jsonb, "appliedRedirect" character varying(2048), "appliedAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_identity_console_state" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "identity_console_state"`);
  }
}
