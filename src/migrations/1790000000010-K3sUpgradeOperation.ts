import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The K3s upgrade is recorded as an operation, alone or as one phase of a
 * platform update, and the platform update gains its backup, manifest and K3s
 * steps.
 *
 * Also adds the platform_update_* steps the update already writes, which no
 * earlier migration added.
 *
 * Same shape as the other enum additions: Postgres cannot add a value inside a
 * transaction that then uses it, hence IF NOT EXISTS and no use here. The
 * migrations run in one transaction (`migrationsTransactionMode: 'all'`), and
 * TypeORM refuses a migration that opts out of it with `transaction = false`.
 */
export class K3sUpgradeOperation1790000000010 implements MigrationInterface {
  name = 'K3sUpgradeOperation1790000000010';

  static readonly operationTypes = ['upgrade_k3s'];
  static readonly steps = [
    'platform_update_preflight',
    'platform_update_components',
    'platform_update_control_plane',
    'platform_update_verify',
    'platform_update_backup',
    'platform_update_manifests',
    'platform_update_k3s',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of K3sUpgradeOperation1790000000010.operationTypes) {
      await queryRunner.query(
        `ALTER TYPE "public"."infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    for (const value of K3sUpgradeOperation1790000000010.steps) {
      await queryRunner.query(
        `ALTER TYPE "public"."infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and an operation recorded while it
    // existed would be unreadable if it could.
  }
}
