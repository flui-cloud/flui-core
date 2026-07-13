import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-route gateway policies (auth/rateLimit/allowIps/path) on app endpoints.
 * Dev uses synchronize:true so the column already exists there; this brings
 * prod to parity. Additive and idempotent.
 */
export class AddGatewayConfigToAppEndpoints1782300000000
  implements MigrationInterface
{
  name = 'AddGatewayConfigToAppEndpoints1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_endpoints" ADD COLUMN IF NOT EXISTS "gatewayConfig" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_endpoints" DROP COLUMN IF EXISTS "gatewayConfig"`,
    );
  }
}
