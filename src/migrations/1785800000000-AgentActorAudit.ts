import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the record able to say whether a person or an agent acted, and what the
 * call was.
 *
 * Until now `mcp_tool_call_logs` carried `user_id` and nothing else about
 * identity, and `infrastructure_operations` carried `userId` alone — but a Flui
 * API key is issued *as* its principal and inherits its `isAdmin`, so the row
 * an administrator writes and the row an agent holding that administrator's key
 * writes are identical. Every screen built on these tables is therefore unable
 * to tell them apart, which is exactly the distinction a revoke decision needs.
 *
 * `arguments` holds the call's arguments **already redacted** — see
 * `redactToolArgs`: a closed-set value verbatim, everything else `****`. Raw
 * arguments are never written, because `catalog_install` takes `userInputs` and
 * that is where an admin password lands.
 *
 * Additive and nullable throughout, with no foreign key on `actor_key_id`: the
 * record of what a credential did has to outlive the credential. Nothing is
 * backfilled — a row written before these columns existed cannot be classified
 * after the fact without inventing the answer, and null must be read as
 * "unknown", never as "a person did it".
 */
export class AgentActorAudit1785800000000 implements MigrationInterface {
  name = 'AgentActorAudit1785800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "actor_kind" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "actor_key_id" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "arguments" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "operation_id" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_operations" ADD COLUMN IF NOT EXISTS "actorKind" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_operations" ADD COLUMN IF NOT EXISTS "actorKeyId" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "infrastructure_operations" DROP COLUMN IF EXISTS "actorKeyId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "infrastructure_operations" DROP COLUMN IF EXISTS "actorKind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "operation_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "arguments"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "actor_key_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "actor_kind"`,
    );
  }
}
