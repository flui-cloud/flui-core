import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes three gaps between the entities and what the migrations actually
 * build, found by running the whole chain against an empty database.
 *
 * All three come from the same habit: in development `synchronize: true`
 * shapes the schema from the entities, so a feature can ship its column or its
 * enum value and never notice that no migration creates it. Production runs
 * `migrationsRun` with no synchronize, so there the column is simply absent —
 * and the failure appears the first time somebody uses the feature, as an
 * insert against a type that does not know the value.
 *
 *  - `action_proposals.consequence` — declared on the entity, created nowhere.
 *  - `reinstall_cluster` on the operation-type enum, and the five
 *    `cluster_reinstall_*` steps: `flui env reinstall` writes an operation row
 *    before it does anything, so on a migrated database the command fails at
 *    its first statement.
 *
 * Additive and idempotent. Index-name drift is left alone: the migrations name
 * their indexes and the entities want TypeORM's generated names, which is a
 * cosmetic difference over the same columns, and churning them would rewrite
 * indexes on large tables for nothing.
 */
export class CatchUpEntityDrift1788000000000 implements MigrationInterface {
  name = 'CatchUpEntityDrift1788000000000';

  private readonly steps = [
    'cluster_reinstall_init',
    'cluster_reinstall_purge',
    'cluster_reinstall_bootstrap',
    'cluster_reinstall_observability',
    'cluster_reinstall_finalize',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "action_proposals" ADD COLUMN IF NOT EXISTS "consequence" character varying`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."infrastructure_operations_operationtype_enum" ADD VALUE IF NOT EXISTS 'reinstall_cluster'`,
    );
    for (const step of this.steps) {
      await queryRunner.query(
        `ALTER TYPE "public"."infrastructure_operations_currentstep_enum" ADD VALUE IF NOT EXISTS '${step}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot drop an enum value, and a row written while it existed
    // would be unreadable if it could. The column can go back.
    await queryRunner.query(
      `ALTER TABLE "action_proposals" DROP COLUMN IF EXISTS "consequence"`,
    );
  }
}
