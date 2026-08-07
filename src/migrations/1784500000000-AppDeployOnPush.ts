import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-app continuous auto-deploy policy for git_build apps.
 *
 * Default false (opt-in): existing apps stop auto-deploying on push until the
 * flag is turned on. The very first deploy of an app is unaffected — only
 * redeploys triggered by subsequent commits are gated on this column.
 */
export class AppDeployOnPush1784500000000 implements MigrationInterface {
  name = 'AppDeployOnPush1784500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "deployOnPush" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN "deployOnPush"`,
    );
  }
}
