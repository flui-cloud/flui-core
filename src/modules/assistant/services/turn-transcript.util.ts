import { ChatCompletionMessage, ToolCall } from '../interfaces/chat-completion';

/**
 * What the conversation already says happened — read from the transcript,
 * because the transcript is the only thing that survives the round trip.
 *
 * A chat turn that stops to confirm hands the whole conversation back to the
 * client and gets it returned with a set of approved ids. Steps do not come
 * back, the server keeps nothing, and so *anything a turn did and did not write
 * down did not happen* as far as the next turn can tell. That used to be a
 * harmless property, because a turn that stopped to ask had done nothing.
 *
 * It stopped being harmless when the chat started asking the action cycle its
 * question by making the call: on the one branch where the cycle lets the call
 * through — the person already answered this exact request, or gave a standing
 * yes — the effect happens during the very turn that then returns a card for
 * the *other* calls. Written nowhere, that effect is reported to the model as
 * "denied by the user" on the resume, and performed a second time if the model
 * takes the user at their word and proposes it again.
 */

/** Tool-call ids the transcript already carries a result for. */
export function answeredToolCallIds(
  conversation: readonly ChatCompletionMessage[],
): Set<string> {
  const answered = new Set<string>();
  for (const m of conversation) {
    if (m.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id);
  }
  return answered;
}

/**
 * The tool calls a resume still has to decide, or none when this is a fresh turn.
 *
 * The rule it replaces was *"the last message is an assistant message with
 * tool_calls"*, which is the same answer whenever a turn answered all of its
 * calls or none of them — true of every turn until one of them could answer
 * some. Generalised rather than special-cased: the last assistant message that
 * proposed tool calls, minus the ones the transcript already answers.
 *
 * Reading the last such message and not every one of them is deliberate: an
 * earlier round of the same conversation is finished business, and re-offering
 * its calls would re-run them.
 */
export function unansweredToolCalls(
  conversation: readonly ChatCompletionMessage[],
): ToolCall[] {
  let proposed: ToolCall[] | undefined;
  for (const m of conversation) {
    if (m.role === 'assistant' && m.tool_calls?.length) proposed = m.tool_calls;
  }
  if (!proposed) return [];
  const answered = answeredToolCallIds(conversation);
  return proposed.filter((tc) => !answered.has(tc.id));
}
