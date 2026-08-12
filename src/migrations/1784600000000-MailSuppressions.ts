import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Addresses the platform has stopped writing to.
 *
 * One row per address, enforced by the unique constraint: the question asked of
 * this table is always "may I write to this person right now", and a history of
 * every refusal answers it slower and no better. Callers fold on write, so the
 * constraint is what makes recording the same bounce twice a no-op rather than
 * a duplicate.
 *
 * `scope` is the column that keeps an unsubscribe from a mailing list out of
 * the way of a password reset. Defaulting it to `all` is the safe direction: a
 * row written without an opinion stops everything, which is wrong in the
 * harmless direction.
 */
export class MailSuppressions1784600000000 implements MigrationInterface {
  name = 'MailSuppressions1784600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mail_suppressions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "address" character varying(320) NOT NULL,
        "reason" character varying(16) NOT NULL,
        "scope" character varying(8) NOT NULL DEFAULT 'all',
        "suppressedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "source" character varying(64),
        "detail" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mail_suppressions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_mail_suppressions_address" UNIQUE ("address")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_mail_suppressions_scope"
        ON "mail_suppressions" ("scope")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_mail_suppressions_scope"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "mail_suppressions"`);
  }
}
