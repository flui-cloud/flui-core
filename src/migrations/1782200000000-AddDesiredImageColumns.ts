import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Desired-image SSoT columns on applications: the fencing generation, the
 * build-provenance pointer, and the observed (live-on-cluster) image. Dev uses
 * synchronize:true so these already exist there; this brings prod to parity.
 * All statements are idempotent and additive (safe for running apps).
 */
export class AddDesiredImageColumns1782200000000 implements MigrationInterface {
  name = 'AddDesiredImageColumns1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "desiredImageGeneration" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "desiredBuildId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "observedImageRef" character varying(255)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "observedImageRef"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "desiredBuildId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "desiredImageGeneration"`,
    );
  }
}
