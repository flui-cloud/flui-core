import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The operation a scaling decision started. Empty on every row written before:
 * those decisions never recorded one, and there is no way back to it now.
 */
export class ScalingDecisionOperation1789500000000
  implements MigrationInterface
{
  name = 'ScalingDecisionOperation1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_scaling_decisions" ADD COLUMN IF NOT EXISTS "operationId" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_scaling_decisions" DROP COLUMN IF EXISTS "operationId"`,
    );
  }
}
