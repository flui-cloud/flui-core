import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records where a restore put what it recovered.
 *
 * The three engines defaulted differently and none of them said so: a Velero
 * restore with no `existingResourcePolicy` fills gaps and leaves the rest
 * untouched (a behaviour nobody chose), a logical `db restore` overwrites in
 * place, and a PITR recovery builds a new install beside the source. Without
 * this column "did that restore replace my data?" is answerable only by knowing
 * which command someone happened to run.
 *
 * Nullable: rows written before this cannot be classified after the fact, and
 * guessing one would be worse than admitting we do not know.
 */
export class RestorePlacement1787300000000 implements MigrationInterface {
  name = 'RestorePlacement1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN
         CREATE TYPE "public"."restore_jobs_placement_enum" AS ENUM('new', 'existing');
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    );
    await queryRunner.query(
      `ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "placement" "public"."restore_jobs_placement_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "restore_jobs" DROP COLUMN IF EXISTS "placement"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."restore_jobs_placement_enum"`,
    );
  }
}
