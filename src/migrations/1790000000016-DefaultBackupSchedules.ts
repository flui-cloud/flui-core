import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Continuous database, volume-copy and platform policies were saved without a
 * schedule when none was named, so each ran once and never again, while the
 * command that created it said "on the default schedule". A continuous
 * database kept archiving onto its single base backup with nothing ever
 * expiring.
 *
 * Gives every active one of them the schedule a new policy now gets. Only the
 * schedule: the scheduler fills in the next run at boot. A policy that already
 * has one keeps it, so a second run changes nothing.
 *
 * The class is compared as text: on a fresh database `volume_copy` is added
 * earlier in the same transaction, and Postgres refuses an enum value used
 * before the transaction that added it commits.
 */
export class DefaultBackupSchedules1790000000016 implements MigrationInterface {
  name = 'DefaultBackupSchedules1790000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "backup_policies"
      SET "cronSchedule" = CASE "engineClass"::text
        WHEN 'platform' THEN '0 2 * * *'
        WHEN 'database' THEN '30 2 * * *'
        WHEN 'volume_copy' THEN '30 3 * * *'
      END
      WHERE "status" = 'active'
        AND ("cronSchedule" IS NULL OR btrim("cronSchedule") = '')
        AND (
          "engineClass"::text IN ('platform', 'volume_copy')
          OR (
            "engineClass"::text = 'database'
            AND COALESCE("engine", 'postgres') NOT LIKE '%-dump'
          )
        )
    `);
  }

  public async down(): Promise<void> {
    // A schedule set here cannot be told apart from one a person chose.
  }
}
