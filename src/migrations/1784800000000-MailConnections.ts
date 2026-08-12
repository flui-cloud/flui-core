import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configured ways of sending mail, one row per connection.
 *
 * The partial unique index is the schema's half of an invariant that matters
 * more than it looks: bulk and transactional mail must not share an account, a
 * credential or a sending domain, because a suspension caused by a newsletter
 * would take the password resets with it. One active connection per scope makes
 * "two providers live at once" the normal state and a third unrepresentable.
 *
 * The other two legs of that invariant — same account, same domain — cannot be
 * seen from here (one is inside a ciphertext), so they are checked in the
 * service at activation time against `secretFingerprint` and `sendingDomain`.
 */
export class MailConnections1784800000000 implements MigrationInterface {
  name = 'MailConnections1784800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mail_connections" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "provider" character varying(32) NOT NULL,
        "scope" character varying(16) NOT NULL,
        "label" character varying(120) NOT NULL,
        "sendingDomain" character varying(253),
        "credentialSource" character varying(32) NOT NULL,
        "encryptedSecret" text,
        "secretFingerprint" character varying(64),
        "config" jsonb NOT NULL DEFAULT '{}',
        "encryptedWebhookSecret" text,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mail_connections" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_mail_connections_active" ON "mail_connections" ("scope", "isActive")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_mail_connections_active_scope"
        ON "mail_connections" ("scope") WHERE "isActive"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_mail_connections_active_scope"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_mail_connections_active"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "mail_connections"`);
  }
}
