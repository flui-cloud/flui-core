import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'ovh_object_storage' to the enum backing `backup_destinations.provider`.
 * Without it, provisioning an OVH backup destination fails on insert with 22P02
 * (invalid input value for enum).
 *
 * Same shape as the other enum additions: Postgres cannot add a value inside a
 * transaction that then uses it, hence IF NOT EXISTS and no use here.
 */
export class OvhObjectStorageDestination1788700000000
  implements MigrationInterface
{
  name = 'OvhObjectStorageDestination1788700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."backup_destinations_provider_enum" ADD VALUE IF NOT EXISTS 'ovh_object_storage'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and a destination row already written
    // with provider='ovh_object_storage' would be unreadable if it could.
  }
}
