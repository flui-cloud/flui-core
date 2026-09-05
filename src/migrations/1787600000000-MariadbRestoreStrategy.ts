import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a restore row say which engine brought the data back.
 *
 * `strategy` is the field a person reads months later to answer "how did this
 * database come back?", and until now every database restore said `pg_pitr`
 * because `database` had one implementation. Recording a MariaDB recovery as
 * a pgBackRest one would put a false answer in the only place that answers it.
 *
 * Same shape as the `volume_copy` addition: Postgres cannot add an enum value
 * inside a transaction that then uses it, hence IF NOT EXISTS and no use here;
 * the code writing it ships in the same release.
 */
export class MariadbRestoreStrategy1787600000000 implements MigrationInterface {
  name = 'MariadbRestoreStrategy1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."restore_jobs_strategy_enum" ADD VALUE IF NOT EXISTS 'mariadb_pitr'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and a row written while the value
    // existed would be unreadable if it could.
  }
}
