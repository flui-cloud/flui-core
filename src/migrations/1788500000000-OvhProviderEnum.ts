import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * OVH was added as a CloudProvider value in the application enum, but the
 * Postgres enums backing `vnets.provider` and `infrastructure_operations.provider`
 * were created before OVH existed and never got the new value — any insert or
 * filter with provider='ovh' against these columns fails with 22P02
 * (invalid input value for enum), surfaced to users as "One of the values in
 * this request is not a valid identifier."
 *
 * Same shape as the other enum additions: Postgres cannot add a value inside a
 * transaction that then uses it, hence IF NOT EXISTS and no use here.
 */
export class OvhProviderEnum1788500000000 implements MigrationInterface {
  name = 'OvhProviderEnum1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."vnets_provider_enum" ADD VALUE IF NOT EXISTS 'ovh'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."infrastructure_operations_provider_enum" ADD VALUE IF NOT EXISTS 'ovh'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and a row already written with
    // provider='ovh' would be unreadable if it could.
  }
}
