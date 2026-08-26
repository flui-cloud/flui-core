import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `api_keys.skillVersion` — which instructions the agent holding this key says
 * it is working from.
 *
 * `lastUsedAt` already answers "did this key ever speak, and when". What it
 * cannot answer is *what the thing holding it knows*, and that is the half the
 * decision to revoke actually turns on: a key last used an hour ago by an agent
 * carrying instructions from three releases back is a different risk from the
 * same key held by an up-to-date one.
 *
 * Additive, nullable, no foreign key, no type changed. Null is a statement of
 * its own — "never announced itself" — and deliberately not backfilled with the
 * current version, which would claim every existing key had checked in.
 *
 * One column and not a table: the fact wanted is the last one, not the series.
 * A row per check-in would be a movement log of somebody's agent, and what an
 * agent *did* is already recorded where auditing belongs.
 */
export class AgentSkillVersion1786100000000 implements MigrationInterface {
  name = 'AgentSkillVersion1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "skillVersion" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "skillVersion"`,
    );
  }
}
