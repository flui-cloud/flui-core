import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The HTTP email provider Flui keeps at the identity provider, with its signing
 * key sealed, a category on delivery outcomes so sign-in mail can be told
 * apart from the rest, and a short memory of sent messages by body hash so a
 * retry is not sent twice.
 */
export class IdentityEmail1790000000039 implements MigrationInterface {
  name = 'IdentityEmail1790000000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "identity_email_provider" ("id" character varying(16) NOT NULL, "providerId" character varying(64), "endpoint" character varying(2048), "encryptedSigningKey" text, "active" boolean NOT NULL DEFAULT false, "reason" character varying(64), "lastSyncAt" TIMESTAMP WITH TIME ZONE, "lastSyncError" text, "lastDeliveryAt" TIMESTAMP WITH TIME ZONE, "lastErrorAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_identity_email_provider" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "mail_events" ADD COLUMN IF NOT EXISTS "category" character varying(32)`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "identity_email_deliveries" ("bodyHash" character varying(64) NOT NULL, "state" character varying(16) NOT NULL, "duplicates" integer NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_identity_email_deliveries" PRIMARY KEY ("bodyHash"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_identity_email_deliveries_updated" ON "identity_email_deliveries" ("updatedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "identity_email_deliveries"`);
    await queryRunner.query(
      `ALTER TABLE "mail_events" DROP COLUMN IF EXISTS "category"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "identity_email_provider"`);
  }
}
