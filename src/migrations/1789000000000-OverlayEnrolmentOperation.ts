import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One more value on the operation-type enum: enrolling an existing cluster onto
 * the management overlay.
 *
 * It needs to be an operation rather than a call because of what it does — it
 * deletes the API server's serving certificate and restarts K3s on a live
 * master, so it has to be visible while it runs, and its failure has to be
 * recorded rather than returned to whoever happened to be holding the request.
 *
 * `ADD VALUE IF NOT EXISTS` cannot run inside a transaction on older
 * PostgreSQL, but TypeORM wraps migrations in one. Doing it through
 * `pg_enum` directly keeps the whole batch in a single transaction and is
 * idempotent the same way the rest of this project's migrations are.
 */
export class OverlayEnrolmentOperation1789000000000
  implements MigrationInterface
{
  name = 'OverlayEnrolmentOperation1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        enum_oid oid;
      BEGIN
        SELECT oid INTO enum_oid FROM pg_type
          WHERE typname = 'infrastructure_operations_operationtype_enum';
        IF enum_oid IS NULL THEN
          RETURN;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
            WHERE enumtypid = enum_oid AND enumlabel = 'enrol_cluster_overlay'
        ) THEN
          ALTER TYPE "public"."infrastructure_operations_operationtype_enum"
            ADD VALUE 'enrol_cluster_overlay';
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // PostgreSQL cannot remove a value from an enum. Leaving it costs nothing —
    // no row references it once the feature is gone — and the alternative is
    // rewriting the type and every column that uses it, which is a far worse
    // thing to do on the way *down*.
  }
}
