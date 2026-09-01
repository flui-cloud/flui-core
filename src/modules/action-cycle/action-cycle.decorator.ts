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
   * When this route's own body says the call will not act at all.
   *
   * A handful of routes are two actions on one path: `deploy-from-yaml` takes
   * `validateOnly`, returns the manifest it would have applied and writes
   * nothing, and the tool description tells a model to use exactly that to
   * check a manifest. Pausing it put a person in front of a sentence — "create
   * or replace an application from a manifest and deploy it" — that was not
   * true of the call being made, and stored that sentence verbatim on whatever
   * they conceded. A gate is only worth what its sentence is worth.
   *
   * Same contract as {@link clause}: pure, fed an unvalidated body, read once.
   * Fail-closed in the direction that pauses — a body this cannot read, or one
   * that makes it throw, is treated as the real thing.
   */
  dryRun?: (body: unknown) => boolean;
  /**
   * A GET route that prices **this action**, or previews its impact, as a
   * pattern to be filled from the same request.
   *
   * The guard stores the resolved path and never calls it: a gate that priced
   * its own decision would fail whenever the pricing call failed, which turns
   * a billing question into an availability one. Whoever renders the request
   * has the reference and the caller's own credential.
   *
   * **Only a route that answers "what will this cost / what will it disturb"
   * belongs here.** Six declarations pointed at a current-state read or a plain
   * list — the storage in use, the current billing period, the components, the
   * issuers, the certificates — and both readers were misled by it: the person
   * deciding was offered "the estimate" and handed a list, and the agent was
   * told, in {@link ESTIMATE_WITHHELD_NOTE}, that *"this action has a price you
   * cannot see"*, which for those six was simply untrue. What those routes
   * offered was context, and context has its own field now.
   */
  estimate?: string;
  /**
   * What happens if the person says yes, in one plain sentence.
   *
   * {@link sentence} says what is being asked for; this says what it does. They
   * are different questions and were being answered by the same string, which
   * is why an estimate route kept being pressed into service as a stand-in for
   * the second one.
   *
   * Declared, never derived: the guard cannot know that redeploying a component
   * interrupts it, and a sentence assembled from the verb and the path would be
   * a guess dressed as a fact.
   */
  consequence?: string;
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
