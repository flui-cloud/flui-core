import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The half of the register↔request link that could not be derived: the row that
 * *raised* the question.
 *
 * The other direction already worked without a column — a call that departed
 * under an answer names it through the operation the guard stamped. The call
 * that stopped to ask names nothing: `action_proposals` and
 * `mcp_tool_call_logs` share no key, and correlating them on user, credential
 * and instant would be a guess. A register row that claims the wrong request is
 * worse than one that says nothing, so the fact gets a column and is written
 * where it is known.
 *
 * Additive, nullable, no backfill: no turn that already happened can be tied to
 * a proposal after the fact without inventing the tie.
 *
 * **No foreign key**, for the reason `actor_key_id` has none: the register
 * outlives what it names. A request answered and cleaned up, or a permission
 * taken back, must not be able to delete the record of what was asked — and a
 * register that loses rows when somebody revokes is the opposite of what a
 * revoke decision is made on.
 */
export class McpToolCallRaisedProposal1786200000000
  implements MigrationInterface
{
  name = 'McpToolCallRaisedProposal1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" ADD COLUMN IF NOT EXISTS "proposal_id" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_tool_call_logs" DROP COLUMN IF EXISTS "proposal_id"`,
    );
  }
}
