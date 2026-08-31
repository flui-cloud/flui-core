import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `applicationIds` names apps one at a time; a key handed a whole project
 * still needed re-widening every time that project grew. `projectIds` covers
 * the project instead, so an app added to a granted project is reachable on
 * its very next request — no re-issue, no separate step.
 *
 * Additive, nullable, no foreign key — same reasoning as `applicationIds`
 * next to it: `synchronize: true` against a real cluster's Postgres drops a
 * column TypeORM cannot recognise, and a project id here can span zero, one,
 * or many rows in `projects`, not a single referent to constrain against.
 *
 * Null on every existing row, reading as "no project grant" — the same
 * convention as `applicationIds: null` and `scopes: null` before it.
 */
export class ApiKeyProjectScope1787000000000 implements MigrationInterface {
  name = 'ApiKeyProjectScope1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "projectIds" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "projectIds"`,
    );
  }
}
