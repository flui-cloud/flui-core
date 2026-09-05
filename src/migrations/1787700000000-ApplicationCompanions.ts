import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records the containers that ride with an application without being it.
 *
 * Introduced for MariaDB's binary-log shipper: MariaDB has no equivalent of
 * Postgres's `archive_command`, so something has to be alive and reading its
 * logs continuously, and kubelet is the only supervisor that restarts it,
 * counts the restarts and keeps its output. The same column carries the init
 * container that recovers a data directory before the server first looks at
 * it, and the pod volumes both need.
 *
 * Nullable, no backfill, no default beyond absent: every existing application
 * has no companions, and rendering must leave its manifest byte-identical.
 */
export class ApplicationCompanions1787700000000 implements MigrationInterface {
  name = 'ApplicationCompanions1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "companions" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "companions"`,
    );
  }
}
