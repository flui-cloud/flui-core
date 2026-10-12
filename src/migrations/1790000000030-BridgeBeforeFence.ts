import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The step a full migration shows while its app leg opens the bridge, before
 * the source database is fenced. Postgres cannot use a value added in the
 * same transaction, hence IF NOT EXISTS and nothing else here.
 */
export class BridgeBeforeFence1790000000030 implements MigrationInterface {
  name = 'BridgeBeforeFence1790000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS 'full_migrate_bridge_open'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and a row written while it existed
    // would be unreadable if it could.
  }
}
