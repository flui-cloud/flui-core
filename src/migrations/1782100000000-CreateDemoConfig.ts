import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HN demo (MVP-6): the single-row `demo_config` table holding the loop's
 * configuration, state machine, and honest served/lost counters. Dev uses
 * synchronize:true so this already exists there; brings prod to parity.
 */
export class CreateDemoConfig1782100000000 implements MigrationInterface {
  name = 'CreateDemoConfig1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "demo_config_provisionmode_enum" AS ENUM ('fixed-pair', 'ephemeral');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "demo_config_state_enum" AS ENUM ('idle', 'migrating', 'draining', 'failed');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "demo_config" (
        "id" varchar(16) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "provisionMode" "demo_config_provisionmode_enum" NOT NULL DEFAULT 'fixed-pair',
        "appId" uuid,
        "dbAppId" uuid,
        "clusterAId" uuid,
        "clusterBId" uuid,
        "ownerUserId" varchar(64),
        "probeUrl" varchar(512),
        "probeIntervalMs" integer NOT NULL DEFAULT 2000,
        "intervalMinutes" integer NOT NULL DEFAULT 45,
        "drainMinutes" integer NOT NULL DEFAULT 10,
        "stagingMode" varchar(16) NOT NULL DEFAULT 'live-fenced',
        "state" "demo_config_state_enum" NOT NULL DEFAULT 'idle',
        "currentClusterId" uuid,
        "activeFullMigrationId" uuid,
        "cutoverRequestedAt" timestamptz,
        "pendingCleanupMigrationId" uuid,
        "strikes" integer NOT NULL DEFAULT 0,
        "windowOpen" boolean NOT NULL DEFAULT false,
        "cycleCount" integer NOT NULL DEFAULT 0,
        "cycleStartedAt" timestamptz,
        "drainStartedAt" timestamptz,
        "lastCycleAt" timestamptz,
        "lastCycleDurationMs" integer,
        "lastError" text,
        "probesTotal" bigint NOT NULL DEFAULT 0,
        "probesOk" bigint NOT NULL DEFAULT 0,
        "probesFailed" bigint NOT NULL DEFAULT 0,
        "failedDuringMigration" bigint NOT NULL DEFAULT 0,
        "lastProbeAt" timestamptz,
        "lastProbeOk" boolean,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_demo_config" PRIMARY KEY ("id")
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "demo_config"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "demo_config_state_enum"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "demo_config_provisionmode_enum"`,
    );
  }
}
