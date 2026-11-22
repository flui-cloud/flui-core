import { MigrationInterface, QueryRunner } from 'typeorm';

/** A day of sent identity mail by keyed recipient hash, so one address can be capped. */
export class IdentityEmailSends1790000000047 implements MigrationInterface {
  name = 'IdentityEmailSends1790000000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "identity_email_sends" ("id" BIGSERIAL NOT NULL, "recipientHash" character varying(64) NOT NULL, "sentAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_identity_email_sends" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_identity_email_sends_recipient" ON "identity_email_sends" ("recipientHash", "sentAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_identity_email_sends_sent" ON "identity_email_sends" ("sentAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "identity_email_sends"`);
  }
}
