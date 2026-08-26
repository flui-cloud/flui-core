import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a GitHub App installation exist without a Flui user, and gives the
 * GitHub login its own place.
 *
 * The webhook that records an installation knows who clicked Install on
 * GitHub, not which Flui user will connect it — so it used to write that login
 * into `user_id`, a column the OAuth discovery fills with a Flui UUID. One
 * column, two kinds of value, and anyone filtering on it later would silently
 * drop every webhook-registered installation.
 *
 * `user_id` becomes nullable so "nobody has claimed this yet" can be said
 * instead of guessed, and `installed_by_login` keeps the login as what it
 * actually is: a diagnostic.
 *
 * Nothing is backfilled. Rows already carrying a login in `user_id` keep it;
 * rewriting them is a data migration, and the OAuth discovery already
 * overwrites `user_id` with the real Flui id the first time that user connects.
 */
export class GitHubInstallationUnattributed1786300000000
  implements MigrationInterface
{
  name = 'GitHubInstallationUnattributed1786300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "github_app_installations" ALTER COLUMN "user_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "github_app_installations" ADD COLUMN IF NOT EXISTS "installed_by_login" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "github_app_installations" DROP COLUMN IF EXISTS "installed_by_login"`,
    );
    // NOT NULL is deliberately not restored: it would fail on exactly the rows
    // this migration exists to allow, and dropping them to satisfy it would
    // lose installations.
  }
}
