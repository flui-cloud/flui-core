import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ports a cluster's applications may reach outside it. Null on every
 * existing row, which keeps them open as they have always been.
 */
export class ClusterEgressPolicy1790000000023 implements MigrationInterface {
  name = 'ClusterEgressPolicy1790000000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" ADD COLUMN IF NOT EXISTS "egressPolicy" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" DROP COLUMN IF EXISTS "egressPolicy"`,
    );
  }
}
