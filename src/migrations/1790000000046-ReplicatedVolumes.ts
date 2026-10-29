import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enabling replicated volumes on a cluster is an operation of its own: the
 * nodes that hold the copies are prepared, the volume engine is installed and
 * the storage class appears.
 */
export class ReplicatedVolumes1790000000046 implements MigrationInterface {
  name = 'ReplicatedVolumes1790000000046';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS 'enable_replicated_volumes'`,
    );
    for (const step of [
      'replicated_prepare_nodes',
      'replicated_install_engine',
      'replicated_storage_class',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${step}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and an operation recorded while it
    // existed would be unreadable if it could.
  }
}
