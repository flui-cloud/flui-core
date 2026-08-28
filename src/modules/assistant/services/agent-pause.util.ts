import {
  ACTION_PROPOSAL_DENIED_CODE,
  ESTIMATE_WITHHELD_NOTE,
  PROPOSAL_DECISION,
  ProposalRefusal,
} from '../../action-cycle/action-cycle.core';
import { McpApiCaller, McpApiError } from '../../mcp/services/mcp-api.client';

/**
 * What happens when the assistant's own tool call meets the action cycle.
 *
 * Kept away from the agent loop, and with no Nest and no inference client in
 * sight, for the reason `action-cycle.core.ts` exists: the loop imports the
 * Kubernetes client somewhere down its tree, which the test runner refuses, so
 * anything left inside it cannot be asked a question. The previous round wrote
 * a proof of that surface, watched it fail for exactly that reason and deleted
 * it. The rules that matter live here instead, where they can be proved.
 */

/**
 * The one place that says a tool call did not take effect because somebody is
 * being asked.
 *
 * It has to be recognisable as *not executed*: the loop rebuilds "what already
 * happened in this conversation" by reading the tool results back out of the
 * transcript, and a wait that read as a success would make the resume refuse to
 * run the very call the person just allowed.
 */
export const AGENT_WAIT_PREFIX = 'WAITING on you';

/** Read the action cycle's refusal off whatever a tool threw. Fail-closed. */
export function proposalRefusalOf(error: unknown): ProposalRefusal | undefined {
  return error instanceof McpApiError ? error.proposal : undefined;
}

/** True for a tool result that says nothing was done because a person is being asked. */
export function isWaitingOnPerson(result: string): boolean {
  return result.trim().startsWith(AGENT_WAIT_PREFIX);
}

/**
 * Did this tool result mean *nothing happened*?
 *
 * The loop rebuilds "what has already been done in this conversation" by
 * reading tool results back out of the transcript, and refuses to run a
 * write twice. A wait has to be counted here: it is a call that did not run
 * and that the person is, right now, being asked to allow — if it read as
 * done, the resume would refuse the very call they just allowed, and the
 * assimilation would have broken the function it was meant to govern.
 */
export function didNotTakeEffect(result: string): boolean {
  if (isWaitingOnPerson(result)) return true;
  return /^(denied|refused|error|action denied)/i.test(result.trim());
}

/**
 * What the model is told when the request could not be answered in place.
 *
 * Deliberately not phrased as a failure. An agent that reads "error" either
 * abandons the task or varies the arguments to get around it, and varying them
 * raises a second question instead of answering the first.
 */
export function waitMessage(refusal: ProposalRefusal): string {
  const where = refusal.decideUrl ? ` at ${refusal.decideUrl}` : '';
  const priced = refusal.estimateWithheld ? ` ${ESTIMATE_WITHHELD_NOTE}` : '';
  const effect = refusal.consequence
    ? ` If allowed: ${refusal.consequence}`
    : '';
  return (
    `${AGENT_WAIT_PREFIX}: this needs you to allow it first — "${refusal.sentence}". ` +
    `NOTHING was changed and nothing failed. Tell the user what was asked for and that ` +
    `they can allow it${where}; do not retry it in this turn and do not reword it.${effect}${priced}`
  );
}

/**
 * The cycle's fourth answer: *this exact call was already refused, and the
 * answer stands.*
 *
 * It arrives as a 403 like every other refusal, and that is the trap: nothing
 * else on the wire tells it apart from "you are not allowed on this resource",
 * so both surfaces present a settled decision as an access-control failure. The
 * code is the one thing that survives the exception filter intact, so the code
 * is what this reads.
 *
 * Why it matters here more than anywhere else: the chat's own confirmation is
 * driven by the tool's tier, not by the cycle, so without this the person is
 * handed a "Confirm delete" card for a call the machine has already answered
 * NO to — asked again about something they decided, and told a lie about it
 * either way they click.
 */
export function isStandingRefusal(error: unknown): boolean {
  return (
    error instanceof McpApiError && error.code === ACTION_PROPOSAL_DENIED_CODE
  );
}

/**
 * Deliberately shaped like the wait: same "nothing happened" reading for the
 * transcript, opposite instruction about retrying.
 *
 * `didNotTakeEffect` has to say **true** of this string — the loop rebuilds
 * what already happened from the transcript, and a settled refusal is a call
 * that did not run — while the model has to be told the opposite of what a wait
 * tells it: not "retry once they answer" but "they answered; stop".
 */
export {
  AGENT_STANDING_REFUSAL_PREFIX,
  standingRefusalMessage,
} from '../../action-cycle/action-cycle.core';

/**
 * What the register is told about a turn the cycle stopped.
 *
 * Both halves come from the same fact and are written together, because the
 * round that split them is exactly how this surface ended up recording a wait
 * as `allowed: true, outcome: null` — a row the register reads as "started
 * nothing", which is the opposite of what happened.
 *
 * Pure and out here rather than inline in the loop for the reason the rest of
 * this file is: the loop cannot be stood up in a test, so a rule left inside it
 * is a rule nobody can ask a question of.
 */
export function waitingAuditRow(refusal?: ProposalRefusal): {
  outcome: string | null;
  proposalId: string | null;
} {
  if (!refusal) return { outcome: null, proposalId: null };
  return { outcome: 'input_required', proposalId: refusal.proposalId };
}

/**
 * Record the person's in-chat "yes" as an answer to the request the API raised,
 * and say whether the retry may go ahead.
 *
 * It goes through the API's own decision route rather than the service behind
 * it, and on the **person's** credential with no surface declared — which is
 * the whole safety of this path. `ActionCycleController` refuses an agent
 * answering its own request, so a chat driven by an agent credential is refused
 * here exactly as it would be at the panel, and the wait stands. Reaching for
 * the service in process would have skipped that line, and with it the only
 * thing separating the applicant from the approver.
 *
 * **What makes answering for somebody legitimate is that they read it.** For a
 * while this was called on a click given to a card built from a tool name,
 * against a request raised afterwards and out of sight — a yes to a sentence
 * nobody had shown. The request is now raised before the card and carried on
 * it, and the loop calls this only where that is true; see
 * `action-cycle-reach.ts`.
 *
 * "Once", never "always": the person assented to this call with these
 * arguments, and a standing permission is a different sentence that has to be
 * read before it is given.
 *
 * It is **not** true that this surface cannot carry one — an earlier round said
 * so and was wrong. `actorOf` gives an assistant with no API key behind it the
 * fixed identity `surface:assistant`, so a request this chat raises does state a
 * credential, `offersAlways` is true on it whenever the action declares a
 * boundary, and a concession granted on the requests page covers this chat's
 * later calls. What follows from that is the opposite of "never offered": a
 * standing yes given elsewhere makes the call go through here, and the card is
 * never built — which is why what happens then has to be shown rather than
 * silently done.
 */
export async function assentInChat(
  asPerson: McpApiCaller,
  refusal: ProposalRefusal,
): Promise<boolean> {
  try {
    await asPerson.post(
      `/agent/proposals/${encodeURIComponent(refusal.proposalId)}/decide`,
      { decision: PROPOSAL_DECISION.ONCE },
    );
    return true;
  } catch {
    // An expired question, one already answered, or a chat that is not the
    // owner's to answer. The wait stands and the person is told where to go —
    // failing open here would be the one bug this whole path exists to prevent.
    return false;
  }
}
