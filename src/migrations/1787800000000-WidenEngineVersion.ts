import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes room for a second engine's version banner.
 *
 * 32 characters fitted Postgres, whose `server_version` reads
 * `17.10 (Debian 17.10-1.pgdg13+1)` at 30. MariaDB answers
 * `11.3.2-MariaDB-1:11.3.2+maria~ubu2204-log` at 41, and the insert failed
 * AFTER the base backup had already been streamed to object storage — a real
 * backup, a job marked failed, and no row pointing at either.
 *
 * Widening only. The write side clamps as well, so the length of a banner can
 * never again decide whether a backup that exists is recorded.
 */
export class WidenEngineVersion1787800000000 implements MigrationInterface {
  name = 'WidenEngineVersion1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backup_artifacts" ALTER COLUMN "engineVersion" TYPE character varying(64)`,
    );
  }

  public async down(): Promise<void> {
    // Narrowing again would truncate rows written since, so this does not.
  }
}
