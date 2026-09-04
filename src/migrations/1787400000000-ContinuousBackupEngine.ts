import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separates "this is a database backup" from "this is a pgBackRest backup".
 *
 * `engineClass = 'database'` has meant pgBackRest by accident of there being
 * only one implementation. That was exact until a second continuous engine
 * existed, and the backfill below is exact for the same reason: every database
 * artifact ever written came from pgBackRest, so `postgres` is a fact about
 * them, not a guess.
 *
 * `engineVersion` closes a failure that waits for a major upgrade to bite. A
 * database restore installs the catalog slug at whatever tag the seed carries
 * at that moment. With no major version on the artifact, the day a seed moves
 * from 17 to 18 every backup taken on 17 is restored into an 18 image, and a
 * version 17 data directory does not open under 18 — surfacing during a
 * recovery, which is the worst moment to discover it. Recording the version
 * does not fix the restore on its own; it makes the mismatch detectable
 * instead of silent.
 *
 * Both columns are nullable: rows written before this cannot be classified
 * after the fact for `engineVersion`, and inventing one would be worse than an
 * empty field a restore can refuse on.
 */
export class ContinuousBackupEngine1787400000000 implements MigrationInterface {
  name = 'ContinuousBackupEngine1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "engine" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ADD COLUMN IF NOT EXISTS "engine" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ADD COLUMN IF NOT EXISTS "engineVersion" character varying(32)`,
    );

    // Exact, not a default: `database` has had exactly one implementation.
    await queryRunner.query(
      `UPDATE "backup_policies" SET "engine" = 'postgres' WHERE "engineClass" = 'database' AND "engine" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "backup_artifacts" SET "engine" = 'postgres' WHERE "engineClass" = 'database' AND "engine" IS NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_backup_artifacts_engine" ON "backup_artifacts" ("engine")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_backup_artifacts_engine"`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" DROP COLUMN IF EXISTS "engineVersion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" DROP COLUMN IF EXISTS "engine"`,
    );
    await queryRunner.query(
      `ALTER TABLE "backup_policies" DROP COLUMN IF EXISTS "engine"`,
    );
  }
}
