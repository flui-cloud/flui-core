/**
 * MRTR — multi-round-trip requests, from MCP revision 2026-07-28
 * (`basic/patterns/mrtr`).
 *
 * A tool that needs something the agent must not hold — a human confirmation, a
 * password, a card number — does not fail. It returns `resultType:
 * 'input_required'` with the requests it needs fulfilled; the client gathers the
 * input and **retries the original call**, this time carrying `inputResponses`.
 * The distinction matters more than it looks: an agent that reads a failure
 * retries blindly, and a blind retry on a half-finished mutation does damage.
 *
 * **This file used to be an implementation. It is now a seam.** While the
 * installed SDK spoke 2025-11-25 there was no codec to lift these fields off
 * the wire, so section 3 mirrored the published `@modelcontextprotocol/core`
 * declarations by hand and bridged the retry leg through `_meta`. Section 7
 * moved the server onto `@modelcontextprotocol/server@2.0.0`, which implements
 * the revision — so every constructor, reader and predicate below is now the
 * package's own, re-exported through one place. Nothing here re-implements
 * anything: two implementations of one protocol drift, and the drift is only
 * discovered by the client that breaks.
 *
 * What the seam still decides is **policy**, which is ours and not the
 * transport's:
 *
 *  - the only embedded requests this server will ever emit are the two
 *    elicitation forms. The package's builder also offers
 *    `sampling/createMessage` and `roots/list`; both are deprecated by
 *    SEP-2577, and {@link inputRequired} is typed here so they cannot be
 *    reached by accident;
 *  - `requestState` comes back **raw and unverified**. The package ships a
 *    verification hook (`ServerOptions.requestState.verify`) and an HMAC codec
 *    (`createRequestStateCodec`) to fill it; which key would sign it is not
 *    settled, so the hook is left unconfigured and the obligation stays
 *    visible instead of being hidden behind an accessor that looks safe.
 */

import {
  inputRequired as sdkInputRequired,
  type ElicitInputParams,
  type ElicitRequestURLParams,
  type InputRequest,
  type InputRequiredResult,
  type InputRequiredSpec,
} from '@modelcontextprotocol/server';

export type {
  ElicitInputParams,
  InputRequest,
  InputRequiredResult,
  InputRequiredSpec,
};

export type {
  InputRequests,
  InputResponses,
  InputResponseView,
} from '@modelcontextprotocol/server';

/**
 * The package's builder, narrowed to the two request kinds this server emits.
 *
 * The runtime object is the SDK's, unchanged — only the type is smaller. The
 * specification also allows `sampling/createMessage` and `roots/list` as
 * embedded requests and the package exposes builders for both; both are
 * deprecated as of 2026-07-28 (SEP-2577). Closing the door at the type level
 * costs nothing and stops a deprecation from entering through a hole we opened
 * ourselves.
 */
export interface ElicitationOnlyInputRequired {
  (spec: InputRequiredSpec): InputRequiredResult;
  elicit(params: ElicitInputParams): InputRequest;
  elicitUrl(
    params: Omit<ElicitRequestURLParams, 'mode' | 'elicitationId'>,
  ): InputRequest;
}

export const inputRequired: ElicitationOnlyInputRequired = sdkInputRequired;

/**
 * The specification's own discriminator, not a symbol of ours: a handler
 * authors `resultType: 'input_required'`, the codec stamps `'complete'` on
 * everything else.
 */
export { isInputRequiredResult as isInputRequired } from '@modelcontextprotocol/server';

export { acceptedContent, inputResponse } from '@modelcontextprotocol/server';

/**
 * What the current round of a multi-round-trip call carried.
 *
 * The package lifts `inputResponses` and `requestState` out of the `tools/call`
 * params before a handler sees them and hands them over on the request context
 * (`ctx.mcpReq`). {@link readRound} is the one place that reads them, so the
 * tool surface keeps a plain object instead of an SDK context object it would
 * otherwise have to carry through the assistant loop as well.
 */
export interface McpRequestRound {
  /**
   * The bare response objects the client sent back, keyed by the identifiers
   * this server assigned in `inputRequests`. Left as `unknown` values on
   * purpose: they come from the other side of the wire and the SDK does not
   * validate them either — {@link acceptedContent} is the reader that narrows
   * one safely.
   */
  inputResponses?: Record<string, unknown>;
  requestState?: string;
}

/** The subset of the SDK's request context a round is read from. */
export interface McpRequestRoundSource {
  inputResponses?: Record<string, unknown>;
  requestState?: <T = unknown>() => T | undefined;
}

/**
 * Reads the round off the SDK's per-request context.
 *
 * `requestState` is returned as the raw wire string: with no
 * `requestState.verify` hook configured, that is exactly what the package's
 * accessor yields, and it is attacker-controlled input on re-entry (spec:
 * mrtr, server requirements 4–5). Nothing in this codebase may let it decide
 * authorization or which resource is touched until it is signed.
 */
export function readRound(source?: McpRequestRoundSource): McpRequestRound {
  const round: McpRequestRound = {};
  const responses = source?.inputResponses;
  if (responses && typeof responses === 'object') {
    round.inputResponses = responses;
  }
  const state = source?.requestState?.();
  if (typeof state === 'string' && state) round.requestState = state;
  return round;
}

/** The raw, unverified state string. See the note at the top of this file. */
export function readRequestState(round?: McpRequestRound): string | undefined {
  return round?.requestState;
}
