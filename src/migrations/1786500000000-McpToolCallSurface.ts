import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The register stops being the MCP server's and becomes the credential's —
 * without the rename that would say so.
 *
 * `mcp_tool_call_logs` was written by the MCP surface and by the assistant. An
 * agent presenting the same key straight at a route left nothing at all, and
 * the panel that promises *what your agent did* was silent about exactly the
 * calls the action cycle exists to stop. Two columns, so the table can say what
 * it now holds:
 *
 *  - `surface` — which door the row came through. The honest alternative was to
 *    rename the table, and renaming it under `synchronize: true` drops it with
 *    its rows in it. A dated name with a truthful column beats a clean name
 *    with no history;
 *  - `grant_id` — the answer that removed the pause, recorded where it is
 *    known. The two agentic surfaces reach that fact through the operation a
 *    call started, because a tool result carries the operation id back; a guard
 *    runs before the handler and never learns what it created, so deriving it
 *    there is not available and inventing it is not allowed.
 *
 * Additive, nullable, no backfill and **no foreign keys**, for the reason
 * `actor_key_id` has none: the register outlives what it names, and a
 * permission taken back must not take the record of what departed under it with
 * it. Null is not `api` and is not "no grant" — it is a row written before the
 * column existed, and the reader holds it apart.
 */
export class McpToolCallSurface1786500000000 implements MigrationInterface {
  name = 'McpToolCallSurface1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "surface" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "grant_id" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "grant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "surface"`,
    );
  }
}
