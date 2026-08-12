import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery outcomes, one row per message and recipient.
 *
 * The unique constraint carries the design: providers report state rather than
 * history, and the poller re-reads a window it has already seen so that a
 * refusal arriving hours after the send is not missed. Upserting on the triple
 * makes that re-read free; appending would count every message once per poll.
 *
 * `provider` is part of that key. A message id is assigned by the provider and
 * unique to nobody globally, so with two connections live a collision would
 * drive the upsert into another provider's row.
 *
 * Kept for thirty days by a sweep, not by the schema — the retention decision
 * is about other people's addresses and belongs somewhere a reader can find it,
 * next to the code that deletes.
 */
export class MailEvents1784700000000 implements MigrationInterface {
  name = 'MailEvents1784700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mail_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" character varying(16) NOT NULL,
        "provider" character varying(32) NOT NULL,
        "messageId" character varying(255) NOT NULL,
        "recipient" character varying(320) NOT NULL,
        "fromAddress" character varying(320),
        "subject" text,
        "at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reason" text,
        "code" integer,
        "permanent" boolean,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mail_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_mail_events_provider_message_recipient" UNIQUE ("provider", "messageId", "recipient")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_mail_events_at" ON "mail_events" ("at")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_mail_events_from" ON "mail_events" ("fromAddress")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_mail_events_from"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_mail_events_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mail_events"`);
  }
}
