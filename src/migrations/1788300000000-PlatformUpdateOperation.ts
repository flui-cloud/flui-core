import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A platform update is recorded as an operation like every other multi-minute
 * action, so its type has to exist before one can be written.
 *
 * Same shape as the other enum additions: Postgres cannot add a value inside a
 * transaction that then uses it, hence IF NOT EXISTS and no use here.
 */
export class PlatformUpdateOperation1788300000000
  implements MigrationInterface
{
  name = 'PlatformUpdateOperation1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS 'update_platform'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and an update recorded while it
    // existed would be unreadable if it could.
  }
}
