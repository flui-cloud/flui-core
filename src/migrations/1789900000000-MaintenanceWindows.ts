import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A cluster's maintenance window, an application's exception to it, and the
 * actions waiting for the next opening.
 */
export class MaintenanceWindows1789900000000 implements MigrationInterface {
  name = 'MaintenanceWindows1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" ADD COLUMN IF NOT EXISTS "maintenanceWindow" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "maintenance" jsonb`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "deferred_actions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" varchar NOT NULL,
        "clusterId" uuid NOT NULL,
        "applicationId" uuid,
        "requestedBy" varchar NOT NULL,
        "requestedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "runAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "status" varchar NOT NULL DEFAULT 'pending',
        "outcome" text,
        "settledAt" TIMESTAMP WITH TIME ZONE,
        "payload" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_deferred_actions" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_deferred_actions_due" ON "deferred_actions" ("status", "runAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_deferred_actions_cluster" ON "deferred_actions" ("clusterId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "deferred_actions"`);
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "maintenance"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" DROP COLUMN IF EXISTS "maintenanceWindow"`,
    );
  }
}
