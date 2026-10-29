import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A managed Postgres that moved to a highly available cluster records it on
 * its own application row. NULL is the single instance every install has.
 */
export class DatabaseHa1790000000045 implements MigrationInterface {
  name = 'DatabaseHa1790000000045';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "databaseHa" jsonb`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS 'activate_database_ha'`,
    );
    for (const step of [
      'db_ha_prepare',
      'db_ha_copy',
      'db_ha_fence',
      'db_ha_promote',
      'db_ha_switch',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${step}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "databaseHa"`,
    );
  }
}
