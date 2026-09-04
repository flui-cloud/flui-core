import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brings ad-hoc volume copies into the same ledger as every other backup.
 *
 * `flui app snapshot` and `flui app backup` produced copies that existed only
 * as Kubernetes objects and an `infrastructure_operations` row: no job, no
 * artifact, no destination link. Nothing in Flui could answer "what copies
 * exist for this app", and the S3 archive had no list command at all because
 * there was nothing to list from. They are the same kind of thing as every
 * other backup — one engine among several — so they get the same rows.
 *
 * Two additive changes, no backfill:
 *
 *  - `volume_copy` joins the engine enums. Postgres cannot add an enum value
 *    inside a transaction that then uses it, hence IF NOT EXISTS and no use
 *    here; the code writing it ships in the same release.
 *  - `applicationId` / `volumeName` on jobs and artifacts. The database engine
 *    already needed the application and dug it out of `manifestSummary` with a
 *    jsonb query; promoting it to a column serves both engines and lets
 *    "backups for this app" be an index lookup rather than a scan.
 *
 * Nullable on purpose: every existing row predates the concept, and a
 * cluster-wide Velero backup legitimately belongs to no single application.
 */
export class VolumeCopyLedger1787200000000 implements MigrationInterface {
  name = 'VolumeCopyLedger1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."backup_policies_engineclass_enum" ADD VALUE IF NOT EXISTS 'volume_copy'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."backup_artifacts_engineclass_enum" ADD VALUE IF NOT EXISTS 'volume_copy'`,
    );

    for (const table of ['backup_jobs', 'backup_artifacts']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "applicationId" uuid`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "volumeName" character varying(253)`,
      );
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_backup_artifacts_application" ON "backup_artifacts" ("applicationId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_backup_jobs_application" ON "backup_jobs" ("applicationId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_backup_jobs_application"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_backup_artifacts_application"`,
    );
    for (const table of ['backup_jobs', 'backup_artifacts']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "volumeName"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "applicationId"`,
      );
    }
    // The enum values stay: Postgres cannot drop one, and a row written while
    // this release was live would become unreadable if the type were recreated.
  }
}
