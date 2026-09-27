import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A storage price is a fraction of a cent per GB — Scaleway's is 1.606 — so
 * the column holds decimals. Destinations Flui created on Scaleway get the
 * list price, which is what they cost unless their owner says otherwise.
 */
export class DestinationCostDecimal1790000000005 implements MigrationInterface {
  name = 'DestinationCostDecimal1790000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backup_destinations" ALTER COLUMN "costPerGbMonthCents" TYPE numeric(10,4) USING "costPerGbMonthCents"::numeric`,
    );
    await queryRunner.query(`
      UPDATE "backup_destinations"
      SET "costPerGbMonthCents" = 1.606,
          "metadata" = "metadata" || '{"costSource":"list-price"}'::jsonb
      WHERE "provider" = 'scaleway_object_storage'
        AND "costPerGbMonthCents" IS NULL
        AND "metadata"->>'autoProvisioned' = 'true'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backup_destinations" ALTER COLUMN "costPerGbMonthCents" TYPE integer USING round("costPerGbMonthCents")::integer`,
    );
  }
}
