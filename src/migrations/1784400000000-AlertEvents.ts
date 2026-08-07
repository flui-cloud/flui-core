import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alert history reported by Alertmanager.
 *
 * Identity is `(fingerprint, starts_at)`, not the fingerprint alone: Alertmanager
 * reuses a fingerprint when the same condition fires again later, so the start of the
 * episode is what separates one occurrence from the next. The unique constraint is
 * also what makes the receiver's retries safe.
 */
export class AlertEvents1784400000000 implements MigrationInterface {
  name = 'AlertEvents1784400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "alert_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "fingerprint" character varying(64) NOT NULL,
        "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "endsAt" TIMESTAMP WITH TIME ZONE,
        "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "status" character varying(16) NOT NULL,
        "resolvedBy" character varying(16),
        "alertname" character varying(128) NOT NULL,
        "severity" character varying(32) NOT NULL,
        "fluiKind" character varying(32),
        "clusterId" uuid,
        "applicationId" uuid,
        "applicationSlug" character varying(253),
        "namespace" character varying(253),
        "nodeInstance" character varying(253),
        "labels" jsonb NOT NULL DEFAULT '{}',
        "annotations" jsonb NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_alert_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_alert_events_fingerprint_starts_at" UNIQUE ("fingerprint", "startsAt")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_alert_events_status_last_seen"
        ON "alert_events" ("status", "lastSeenAt")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_alert_events_application_starts_at"
        ON "alert_events" ("applicationId", "startsAt")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_alert_events_cluster_starts_at"
        ON "alert_events" ("clusterId", "startsAt")
    `);

    // SET NULL rather than CASCADE: deleting an application should not erase the record
    // that it was down. The denormalized slug and namespace keep the row readable.
    await queryRunner.query(`
      ALTER TABLE "alert_events"
        ADD CONSTRAINT "fk_alert_events_application"
        FOREIGN KEY ("applicationId") REFERENCES "applications"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "alert_events" DROP CONSTRAINT "fk_alert_events_application"`,
    );
    await queryRunner.query(`DROP INDEX "idx_alert_events_cluster_starts_at"`);
    await queryRunner.query(
      `DROP INDEX "idx_alert_events_application_starts_at"`,
    );
    await queryRunner.query(`DROP INDEX "idx_alert_events_status_last_seen"`);
    await queryRunner.query(`DROP TABLE "alert_events"`);
  }
}
