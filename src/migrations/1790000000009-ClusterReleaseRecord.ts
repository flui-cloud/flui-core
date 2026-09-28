import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which bootstrap ref and platform release a cluster's master was installed
 * from. Null for clusters that predate the record.
 */
export class ClusterReleaseRecord1790000000009 implements MigrationInterface {
  name = 'ClusterReleaseRecord1790000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" ADD COLUMN IF NOT EXISTS "bootstrapRef" character varying(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" ADD COLUMN IF NOT EXISTS "platformRelease" character varying(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" DROP COLUMN IF EXISTS "platformRelease"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" DROP COLUMN IF EXISTS "bootstrapRef"`,
    );
  }
}
