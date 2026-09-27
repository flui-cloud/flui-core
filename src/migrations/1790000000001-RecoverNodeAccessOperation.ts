import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One more value on the operation-type enum: getting back into a node whose
 * SSH is closed, through the provider. Same idempotent, in-transaction form as
 * the overlay enrolment value.
 */
export class RecoverNodeAccessOperation1790000000001
  implements MigrationInterface
{
  name = 'RecoverNodeAccessOperation1790000000001';

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
            WHERE enumtypid = enum_oid AND enumlabel = 'recover_node_access'
        ) THEN
          ALTER TYPE "public"."infrastructure_operations_operationtype_enum"
            ADD VALUE 'recover_node_access';
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
