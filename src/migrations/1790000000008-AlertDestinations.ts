import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where alerts go besides the bell: addresses and signed webhooks, plus the
 * single row that says whether administrators are emailed warnings too.
 */
export class AlertDestinations1790000000008 implements MigrationInterface {
  name = 'AlertDestinations1790000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "alert_destinations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" character varying(16) NOT NULL,
        "target" character varying(2048),
        "minSeverity" character varying(16) NOT NULL DEFAULT 'critical',
        "secretEncrypted" text,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdBy" character varying(320),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastDeliveryAt" TIMESTAMP WITH TIME ZONE,
        "lastStatus" character varying(32),
        "lastError" text,
        CONSTRAINT "PK_alert_destinations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_alert_destinations_admins" ON "alert_destinations" ("kind") WHERE "kind" = 'admins'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "alert_destinations"`);
  }
}
