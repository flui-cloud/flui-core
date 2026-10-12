import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The A→B bridge of an application migration: its state on the migration,
 * the moment the source was destroyed, the `bridging` status on both
 * migration machines, and the hold that keeps an endpoint's DNS record in
 * place while the old cluster forwards. Additive; existing migrations read as
 * "no bridge". The enum values are not used in this transaction.
 */
export class MigrationBridge1790000000027 implements MigrationInterface {
  name = 'MigrationBridge1790000000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."app_migrations_status_enum" ADD VALUE IF NOT EXISTS 'bridging'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."full_migrations_status_enum" ADD VALUE IF NOT EXISTS 'bridging'`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" ADD COLUMN IF NOT EXISTS "bridgeState" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" ADD COLUMN IF NOT EXISTS "sourceDestroyedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_endpoints" ADD COLUMN IF NOT EXISTS "dnsHeldBy" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_endpoints" DROP COLUMN IF EXISTS "dnsHeldBy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" DROP COLUMN IF EXISTS "sourceDestroyedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_migrations" DROP COLUMN IF EXISTS "bridgeState"`,
    );
  }
}
