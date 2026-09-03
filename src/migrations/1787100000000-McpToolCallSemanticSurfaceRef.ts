import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which screen a call's turn was asked from, kept apart from `surface`.
 *
 * `mcp_tool_call_logs.surface` already answers a different question — which
 * agentic door the call came through (`mcp` | `assistant`) — and predates the
 * Semantic Surface entirely. Reusing that name for a page-context reference
 * would silently corrupt the column every other reader already trusts, so
 * this fact gets its own: the compact `{surfaceId, revision, route,
 * entityRefs}` shape spec Annex A.4 (item 5) allows into an audit trail —
 * never the full snapshot the user was reading.
 *
 * Additive, nullable, no backfill, no foreign key — for the same reason
 * `grant_id` and `proposal_id` have none: the register outlives what it
 * names, and a row from before this pilot, or from a turn that carried no
 * Surface, must read as "unknown" rather than as a claim about either.
 */
export class McpToolCallSemanticSurfaceRef1787100000000
  implements MigrationInterface
{
  name = 'McpToolCallSemanticSurfaceRef1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "semantic_surface_ref" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "semantic_surface_ref"`,
    );
  }
}
