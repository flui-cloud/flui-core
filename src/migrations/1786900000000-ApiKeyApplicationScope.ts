import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A key's scopes said what it may do; nothing said which applications. On an
 * installation with more than one, minting a key "for" one app handed it every
 * app the issuer owns — the whole account's blast radius, not the one thing
 * the agent was actually asked to work on.
 *
 * `applicationIds`, additive and nullable, no foreign key (same reasoning as
 * `ApplicationOwnerKind`: `synchronize: true` against a real cluster's
 * Postgres drops a column TypeORM cannot recognise, and this one names rows in
 * a table this key may span zero, one, or many of — not a single referent). A
 * `simple-array` column, the same shape `scopes` already uses on this table.
 *
 * Null on every row this migration touches, matching the same convention as
 * `scopes: null`: "nothing was declared" for every key minted before this
 * column existed, which reads as unrestricted — the access those keys already
 * had is not narrowed out from under whoever is holding one today.
 */
export class ApiKeyApplicationScope1786900000000 implements MigrationInterface {
  name = 'ApiKeyApplicationScope1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "applicationIds" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "applicationIds"`,
    );
  }
}
