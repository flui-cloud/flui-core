import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stops the reaper from retrying a hopeless row forever.
 *
 * A tenancy whose cluster no longer has a kubeconfig fails on the same line
 * every minute, writes the same error, and is picked up again by the next
 * sweep — noise that never becomes information. Counting *repeats* of the same
 * error lets the sweep give up on its own, and the row wait for a person in a
 * state that says so.
 */
export class SandboxTenantReapAttempts1785000000000
  implements MigrationInterface
{
  name = 'SandboxTenantReapAttempts1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" ADD COLUMN IF NOT EXISTS "reapAttempts" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "sandbox_tenants" SET "state" = 'failed' WHERE "state" = 'needs_attention'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sandbox_tenants" DROP COLUMN IF EXISTS "reapAttempts"`,
    );
  }
}
