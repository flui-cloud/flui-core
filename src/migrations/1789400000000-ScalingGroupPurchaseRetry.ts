import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a person tells a scaling group to try buying again after a purchase
 * failed. Empty on every existing group: none has been held back yet.
 */
export class ScalingGroupPurchaseRetry1789400000000
  implements MigrationInterface
{
  name = 'ScalingGroupPurchaseRetry1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_scaling_groups" ADD COLUMN IF NOT EXISTS "purchaseRetryAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_scaling_groups" DROP COLUMN IF EXISTS "purchaseRetryAt"`,
    );
  }
}
