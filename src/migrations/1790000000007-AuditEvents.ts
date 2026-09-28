import { MigrationInterface, QueryRunner } from 'typeorm';

/** The record of who did what through the API. */
export class AuditEvents1790000000007 implements MigrationInterface {
  name = 'AuditEvents1790000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" character varying,
        "email" character varying,
        "actorKind" character varying,
        "actorKeyId" character varying,
        "action" character varying NOT NULL,
        "target" jsonb,
        "status" integer,
        "outcome" character varying NOT NULL,
        "permission" character varying,
        "dataAccess" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_audit_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_events_at" ON "audit_events" ("at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_events_email_at" ON "audit_events" ("email", "at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_events"`);
  }
}
