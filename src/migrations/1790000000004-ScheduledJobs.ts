import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schedules recorded by Flui instead of living only as CronJobs in the
 * cluster, where a lost cluster took them with it. Existing CronJobs are
 * imported by the API at boot, as the person's own.
 */
export class ScheduledJobs1790000000004 implements MigrationInterface {
  name = 'ScheduledJobs1790000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "applicationId" uuid NOT NULL,
        "name" character varying(63) NOT NULL,
        "resourceName" character varying(63) NOT NULL,
        "schedule" character varying(128) NOT NULL,
        "command" text NOT NULL,
        "timezone" character varying(64),
        "concurrencyPolicy" character varying(16) NOT NULL DEFAULT 'Forbid',
        "enabled" boolean NOT NULL DEFAULT true,
        "origin" character varying(16) NOT NULL DEFAULT 'user',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_scheduled_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_scheduled_jobs_application" FOREIGN KEY ("applicationId")
          REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_scheduled_jobs_app_name" ON "scheduled_jobs" ("applicationId", "name")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "scheduled_jobs"`);
  }
}
