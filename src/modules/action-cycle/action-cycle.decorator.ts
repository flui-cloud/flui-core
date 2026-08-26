import { SetMetadata } from '@nestjs/common';
import { SentenceClause } from './action-cycle.core';

export const ACTION_CYCLE_KEY = 'agent:actionCycle';

/**
 * What a route declares when it wants an agent to ask before it acts.
 *
 * Same grammar as `@RequireSection`: a decoration read by a global guard, so
 * the rule sits on the shared door every surface goes through — the dashboard,
 * the CLI, `curl` and the MCP server alike — rather than inside a service that
 * only some of them reach. The measurement behind that choice is not an
 * opinion: 46 files inject the operations repository and 122 places build an
 * operation row, so there is no neck in the domain to put this in. The route
 * is the one place where principal, action shape and arguments already exist
 * together.
 */
export interface ActionCycleDecl {
  /**
   * Verb + route pattern, written exactly as the fence writes one and without
   * the API prefix: `POST /infrastructure/clusters/:id/workers`.
   *
   * Declared rather than derived from the handler's metadata because it is the
   * string a concession is stored under: a route pattern that changed shape
   * when Nest changed how it reports one would silently invalidate every
   * standing concession, or worse, silently match a different route.
   */
  action: string;
  /**
   * The route parameters that define this action's edge.
   *
   * Omitted, or naming a parameter the request does not carry, means the
   * request cannot state its own edge — and then it is only ever offered
   * "allow once". That is the mockup's rule made mechanical, and it is
   * fail-closed in the same shape the sandbox tool filter already uses.
   */
  bind?: readonly string[];
  /**
   * What "always" would concede, in the words a person reads before saying
   * yes. `{param}` is filled from the binding.
   *
   * Deliberately narrow prose — "add nodes to cluster {id}", never
   * "infrastructure" — because the sentence is stored verbatim on the
   * concession and is what the register shows when the same person later
   * decides whether to take it back.
   */
  sentence: string;
  /**
   * What this action's *body* adds to the sentence, when the route's parameters
   * do not say the whole of it.
   *
   * Declared by the route because only the route knows what its body means, and
   * a guard that reached into a domain to phrase a question would fail for
   * reasons that have nothing to do with the decision. What is allowed here is
   * therefore narrow — see {@link SentenceClause}: a pure function of an
   * unvalidated body, read once, whose answer is frozen into the stored
   * sentence and never recomputed.
   */
  clause?: SentenceClause;
  /**
   * A GET route that prices this action, as a pattern to be filled from the
   * same request.
   *
   * The guard stores the resolved path and never calls it: a gate that priced
   * its own decision would fail whenever the pricing call failed, which turns
   * a billing question into an availability one. Whoever renders the request
   * has the reference and the caller's own credential.
   */
  estimate?: string;
}

/**
 * Put the route inside the action cycle: an agent gets a proposal instead of an
 * effect, until a person says once or always.
 *
 * The dashboard's forms, the CLI and every service identity pass untouched —
 * the guard fires only for `actor.kind === 'agent'`, which is derived from the
 * credential's `mcp:*` ceiling **or** from the agentic surface the call came
 * through, and from nothing the client can assert. Both sources say the same
 * thing: a model, not a person, wrote these arguments.
 */
export const ActionCycle = (decl: ActionCycleDecl) =>
  SetMetadata(ACTION_CYCLE_KEY, decl);
