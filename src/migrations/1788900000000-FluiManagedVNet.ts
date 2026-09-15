import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two additions for a Flui-provided private network.
 *
 * `vnets.implementation` answers who *builds* the network, which is a different
 * question from `provider` — whose machines it sits on. Conflating them would
 * force the provider enum to carry a value meaningless to credentials, regions
 * and pricing.
 *
 * `wg_peers.subnetId` is the isolation domain: in a Flui-managed VNet, nodes of
 * one subnet peer directly with each other and with nobody else. Null for the
 * management overlay, which has a single domain.
 */
export class FluiManagedVNet1788900000000 implements MigrationInterface {
  name = 'FluiManagedVNet1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."vnets_implementation_enum" AS ENUM('provider-native', 'wireguard');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "vnets"
        ADD COLUMN IF NOT EXISTS "implementation" "public"."vnets_implementation_enum"
        NOT NULL DEFAULT 'provider-native'
    `);
    await queryRunner.query(
      `ALTER TABLE "wg_peers" ADD COLUMN IF NOT EXISTS "subnetId" uuid`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wg_peers_subnet"
        ON "wg_peers" ("subnetId") WHERE "subnetId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_wg_peers_subnet"`);
    await queryRunner.query(
      `ALTER TABLE "wg_peers" DROP COLUMN IF EXISTS "subnetId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vnets" DROP COLUMN IF EXISTS "implementation"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."vnets_implementation_enum"`,
    );
  }
}
