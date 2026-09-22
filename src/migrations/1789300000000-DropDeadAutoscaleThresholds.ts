import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the three per-cluster autoscale thresholds.
 *
 * They were written by the API, echoed back to the dashboard and read by
 * nothing: the warning levels come from the installation-wide defaults, and the
 * engine triggers on a pod that cannot be placed rather than on a utilisation
 * figure. A number a person can set and that changes no behaviour is worse than
 * no number at all, so the storage goes with the form that offered it.
 *
 * The bounds and the enabled flag stay: those still fence what a cluster may
 * grow to on installations where no scaling group owns them yet. They are read
 * only where no group exists — a cluster that has one takes its floor and
 * ceiling from there — so they are a fallback, not a second set of numbers to
 * keep in step. Nothing backfills a group for them: one invented from columns
 * written under the old worker-count meaning would be off by the master.
 */
export class DropDeadAutoscaleThresholds1789300000000
  implements MigrationInterface
{
  name = 'DropDeadAutoscaleThresholds1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" DROP COLUMN IF EXISTS "scaleUpMemoryPct"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" DROP COLUMN IF EXISTS "scaleUpCpuPct"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" DROP COLUMN IF EXISTS "cooldownSeconds"`,
    );
  }

  /**
   * Brings the columns back empty. The values cannot come back — nothing read
   * them, so nothing kept a copy — and restoring the shape is what a rollback
   * of this migration can honestly offer.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" ADD COLUMN IF NOT EXISTS "scaleUpMemoryPct" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" ADD COLUMN IF NOT EXISTS "scaleUpCpuPct" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_clusters" ADD COLUMN IF NOT EXISTS "cooldownSeconds" integer`,
    );
  }
}
