import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a restore row say the data came back from a logical dump.
 *
 * Same shape as the `mariadb_pitr` addition: Postgres cannot add an enum value
 * inside a transaction that then uses it, hence IF NOT EXISTS and no use here.
 */
export class LogicalDumpRestoreStrategy1790000000002
  implements MigrationInterface
{
  name = 'LogicalDumpRestoreStrategy1790000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."restore_jobs_strategy_enum" ADD VALUE IF NOT EXISTS 'logical_dump'`,
    );
  }

  public async down(): Promise<void> {
    return;
  }
}
