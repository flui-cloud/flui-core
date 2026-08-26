/**
 * Why the register has no permission to name on this row.
 *
 * The mockup's fourth rule says the register tells you under which permission
 * every call passed. It does — for the rows where a permission was involved,
 * which is a minority, and until now every other row showed the same mute
 * `null`. A column that is empty for five different reasons is read as a defect
 * of the register rather than as a fact about the call, so the register says
 * which of the five this is.
 *
 * None of these is a guess. Each is read off something already stored:
 *
 *  - `refused` — `allowed: false`. Nothing passed, so no permission carried it;
 *  - `waiting` — `outcome: input_required`. The cycle stopped this call to ask a
 *    person, so it did not go through at all; the answer, when it comes, is on
 *    the *retry*, which is a different row;
 *  - `no-operation` — the call started no async operation, and the operation row
 *    is where the guard stamps its verdict. A read, or a write that finishes
 *    inline, has nowhere to carry one;
 *  - `operation-withheld` — it started one this reader may not see, so the
 *    answer behind it cannot be shown either. Distinct from the one above on
 *    purpose: they used to be the same `null`, and they are opposite facts —
 *    "there is nothing" against "there is something you cannot see";
 *  - `not-paused` — the operation is here, readable, and carries no grant. The
 *    route is not one the action cycle pauses, or the caller was not an agent.
 *    Nothing was asked and nothing was granted; the register is not missing an
 *    answer, there was none to record.
 */
export const UNDER_ABSENT = {
  REFUSED: 'refused',
  WAITING: 'waiting',
  NO_OPERATION: 'no-operation',
  OPERATION_WITHHELD: 'operation-withheld',
  NOT_PAUSED: 'not-paused',
} as const;

export type UnderAbsent = (typeof UNDER_ABSENT)[keyof typeof UNDER_ABSENT];

/** The words a screen shows in place of the empty column. */
export const UNDER_ABSENT_REASON: Record<UnderAbsent, string> = {
  [UNDER_ABSENT.REFUSED]:
    'Nothing was allowed, so there is no permission to name: this call was refused before it could act.',
  [UNDER_ABSENT.WAITING]:
    'This call did not go through — it stopped to ask a person, and `raisedProposalId` names what it asked for. Whatever answer it gets applies to the retry, which is its own row.',
  [UNDER_ABSENT.NO_OPERATION]:
    'This call started no operation, and the operation row is where an answer is recorded. A read, or a write that finished inline, leaves nothing to name here.',
  [UNDER_ABSENT.OPERATION_WITHHELD]:
    'It started an operation you may not read, so the answer behind it is not shown either.',
  [UNDER_ABSENT.NOT_PAUSED]:
    'This route does not pause for a person, so nothing was asked and nothing was granted. There was no answer to record.',
};

/** What one row knows about itself, for the two questions below. */
export interface AnswerContext {
  allowed: boolean;
  outcome: string | null;
  operationId: string | null;
  /** Null both when there is no operation and when this reader may not see it. */
  operationVisible: boolean;
  /** The id the guard stamped on the operation, when the operation is visible. */
  grantId: string | null;
}

/**
 * The reason the column is empty, or `null` when it is not.
 *
 * Ordered from the fact that explains the most: a refused call has no
 * permission behind it whatever else is true of it, and a waiting one is not a
 * failure at all. The two operation cases come last because they are the only
 * ones that depend on who is asking.
 */
export function underAbsentFor(
  ctx: AnswerContext,
  under: 'concession' | 'approval' | null,
): UnderAbsent | null {
  if (under) return null;
  // One column, deliberately, and not "outcome OR the request this row
  // raised". That second read was a stopgap for a surface that recorded a wait
  // without an outcome; now that both surfaces write it, the OR could only
  // ever fire on a row whose writer forgot — and smoothing that over in the
  // reader is how a defect stops being visible. `proposal_id` still says
  // *which* request; `outcome` says *that* there was one.
  if (ctx.outcome === 'input_required') return UNDER_ABSENT.WAITING;
  if (!ctx.allowed) return UNDER_ABSENT.REFUSED;
  if (!ctx.operationId) return UNDER_ABSENT.NO_OPERATION;
  if (!ctx.operationVisible) return UNDER_ABSENT.OPERATION_WITHHELD;
  return UNDER_ABSENT.NOT_PAUSED;
}

/**
 * The request a row can be traced back to, without a column joining the two
 * tables.
 *
 * `action_proposals` and `mcp_tool_call_logs` genuinely do not speak to each
 * other, and the join that is missing is on the row that *raised* the question —
 * that one needs a column and is noted where it belongs. But the other
 * direction, the one a review actually walks, is already derivable and was
 * being thrown away:
 *
 *  - a **one-off** answer stamps the proposal's own id as the grant, so the row
 *    already names its request; the service resolved that id to the word
 *    "approval" and dropped it;
 *  - a **standing** answer stamps a concession id, and the concession records
 *    `fromProposalId` — the question it was born from.
 *
 * Neither is a foreign key and neither may become one: `mcp.module.ts` says why
 * for the credential, and it is the same reason here. A register that loses its
 * rows when a permission is taken back is the opposite of what a revoke needs.
 */
export function proposalBehind(
  under: 'concession' | 'approval' | null,
  grantId: string | null,
  fromProposalId: string | null | undefined,
): string | null {
  if (!grantId) return null;
  if (under === 'approval') return grantId;
  if (under === 'concession') return fromProposalId ?? null;
  return null;
}
