import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `flui cluster rebuild` runs as an operation like every other multi-minute
 * infrastructure action, so its type has to exist before one can be written.
 *
 * Same shape as the other enum additions: Postgres cannot add a value inside a
 * transaction that then uses it, hence IF NOT EXISTS and no use here.
 */
export class RebuildClusterOperation1788200000000
  implements MigrationInterface
{
  name = 'RebuildClusterOperation1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS 'rebuild_cluster'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and a rebuild recorded while it
    // existed would be unreadable if it could.
  }
}
