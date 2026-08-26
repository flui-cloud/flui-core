import {
  ESTIMATE_WITHHELD_NOTE,
  ProposalRefusal,
} from '../../action-cycle/action-cycle.core';

/**
 * Which of the chat's tool calls the action cycle is going to stop — asked
 * *before* the call is made, and answered from the decorations themselves.
 *
 * The portal's chat had its own confirmation and the cycle had another, and
 * the person only ever met the weaker one: a card built from the tool's name,
 * clicked, and then — out of sight, on the resume — an `once` answered on their
 * behalf to a request whose sentence they never read. Answering for somebody is
 * only legitimate where they have seen the thing being answered, so the two
 * questions have to become one, asked where the cycle's own words are.
 *
 * That needs one fact ahead of the call: *would this call be paused?* It is not
 * guessed and not listed by hand — a second list beside the decorations is a
 * second thing to keep in step, and this whole round exists because two
 * surfaces disagreed. Both halves of the comparison are already written down:
 * the tool declares the routes its call is decided on, and the route declares
 * whether it is inside the cycle. This is the join, and nothing else.
 */

/**
 * Is every route this tool's call can land on inside the action cycle?
 *
 * **Fail-closed, and the direction matters.** `true` here permits the chat to
 * make the call before the person has answered — safe only because the guard
 * refuses it and raises a request instead. So a tool that declares nothing, or
 * that can branch onto one undecorated route, must answer `false`: the cost of
 * a wrong `false` is the chat's old card, and the cost of a wrong `true` is a
 * write performed without anybody being asked.
 *
 * `every`, not `some`, for the same reason: `cluster_power` names both `stop`
 * and `start`, and the branch is chosen inside the tool body from an argument.
 * A tool half of whose landings are outside the cycle is outside it.
 */
export function reachesActionCycle(
  routes: readonly string[] | undefined,
  decorated: ReadonlySet<string>,
): boolean {
  if (!routes?.length) return false;
  return routes.every((route) => decorated.has(route));
}

/**
 * The cycle's request as the person confirming in the chat has to see it.
 *
 * Everything here is carried, never composed. The sentence especially: it is
 * what was stored on the proposal, and what a concession copies verbatim if the
 * same wording is ever agreed to standing — so a surface that re-rendered it
 * from a template would be showing a sentence nobody agreed to. There is a
 * pure composer in `action-cycle.core.ts` and it is deliberately not called
 * here: it would have to be fed a binding and a body reconstructed from tool
 * arguments, and "close enough to what the guard wrote" is exactly the class of
 * defect this round is closing.
 */
export interface ChatActionRequest {
  /** The request this call raised, so the answer lands on the one that was read. */
  proposalId: string;
  /** Verbatim, as stored on the proposal. Never re-rendered. */
  sentence: string;
  /**
   * Said when a price is attached and this card is not showing it.
   *
   * The product's one sentence for that fact, carried from the constant rather
   * than worded again here: the MCP surface and the assistant's wait already
   * say it, and a third wording would be a third promise. It is addressed to a
   * model, which is the one thing wrong with it here — see GIRO_P §5.
   */
  estimateNote?: string;
  /** The page that resolves the price and holds the same request. */
  decideUrl?: string;
}

export function chatActionRequest(refusal: ProposalRefusal): ChatActionRequest {
  return {
    proposalId: refusal.proposalId,
    sentence: refusal.sentence,
    estimateNote: refusal.estimateWithheld ? ESTIMATE_WITHHELD_NOTE : undefined,
    decideUrl: refusal.decideUrl,
  };
}
