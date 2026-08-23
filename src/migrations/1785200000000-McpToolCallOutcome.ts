import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets the MCP audit tell "waiting for a person" from "done".
 *
 * A turn that stops to ask for a value records `allowed: true, error: null`,
 * which reads exactly like a success — so the count of deliveries asked for and
 * never completed cannot be taken from this table. `outcome` carries the state;
 * it stays null for every other turn, because `allowed` and `error` already say
 * refused and failed and a column that repeats them is debt.
 *
 * Additive and nullable: nothing is backfilled, because nothing that already
 * happened can be classified after the fact without inventing it.
 */
export class McpToolCallOutcome1785200000000 implements MigrationInterface {
  name = 'McpToolCallOutcome1785200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "outcome" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "outcome"`,
    );
  }
}
