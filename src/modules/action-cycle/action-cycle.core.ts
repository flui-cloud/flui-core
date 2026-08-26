import { createHash } from 'node:crypto';
import { routeMatches } from '../sandbox/constants/sandbox-fence-core';

/**
 * The vocabulary the action cycle is written in — propose, price, approve,
 * execute, attribute, stop — with no dependency on Nest, on a repository or on
 * a request object, so every rule below can be asked a question in a test
 * without standing an application up.
 *
 * Two properties of this file carry most of the design:
 *
 *  - **a concession names a route shape and a resource, never a permission.**
 *    IAM is the ceiling of the person; a concession only removes a *pause* on
 *    something the ceiling already lets through. Writing concessions in the
 *    permission vocabulary would have made "always allow" able to widen the
 *    ceiling it hangs from, which is the one thing it must never do;
 *  - **nothing here ever holds a request body.** The body reaches this file
 *    once, to be hashed, and the hash is what is stored. `catalog_install`
 *    takes `userInputs`, and that is where an administrator password lands —
 *    the same reason round X redacts tool arguments rather than recording them.
 */

/** Route parameters nailed down by a concession, e.g. `{ id: '<uuid>' }`. */
export type ActionBinding = Record<string, string>;

export const PROPOSAL_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  CONSUMED: 'CONSUMED',
  DENIED: 'DENIED',
} as const;

export type ProposalStatus =
  (typeof PROPOSAL_STATUS)[keyof typeof PROPOSAL_STATUS];

/** What a person may answer. `always` also writes a concession. */
export const PROPOSAL_DECISION = {
  ONCE: 'once',
  ALWAYS: 'always',
  DENY: 'deny',
} as const;

export type ProposalDecision =
  (typeof PROPOSAL_DECISION)[keyof typeof PROPOSAL_DECISION];

/**
 * How long a raised proposal stays answerable.
 *
 * It is the estimate's validity window rather than an anti-clutter setting:
 * a proposal carries what the action is expected to cost, and a price agreed on
 * Tuesday for a quote taken on Monday is a lie told by a database. An expired
 * proposal is not decidable; the agent's next attempt regenerates it with a
 * fresh window and a fresh price, which is the only reconciliation this design
 * claims to do (a provider moving its prices inside the window is accepted
 * drift, stated rather than hidden).
 */
export const PROPOSAL_TTL_MS = 60 * 60 * 1000;

/** Raised when an agent's call has no standing permission to proceed. */
export const ACTION_PROPOSAL_CODE = 'ACTION_PROPOSAL_PENDING';

/** Raised when the person answered "no" and the agent tried the same call again. */
export const ACTION_PROPOSAL_DENIED_CODE = 'ACTION_PROPOSAL_DENIED';

/** Routes are declared and matched without the global API prefix. */
export function stripApiPrefix(path: string): string {
  return path.replace(/^\/api\/v\d+/, '');
}

/** `POST /applications/:id/deploy` from its two halves. */
export function actionShape(method: string, pattern: string): string {
  return `${method.toUpperCase()} ${pattern}`;
}

/** The verb and the pattern back out of a shape. */
export function splitShape(shape: string): {
  verb: string;
  pattern: string;
} {
  const at = shape.indexOf(' ');
  if (at < 0) return { verb: '', pattern: shape };
  return { verb: shape.slice(0, at), pattern: shape.slice(at + 1) };
}

/**
 * The route parameters a declaration says define this action's edge.
 *
 * Returns `undefined` — never a partial object — when the declaration names a
 * parameter the request does not carry. That is the mechanical form of the
 * mockup's rule: *a request that cannot state its own edge does not offer
 * "always"*. It is the same fail-closed shape `sandbox-tool-visibility.ts`
 * uses for a tool that declares no routes, and for the same reason: a bound
 * resource that is half-known is a wider grant than anybody agreed to.
 */
export function bindingOf(
  bind: readonly string[] | undefined,
  params: Record<string, unknown> | undefined,
): ActionBinding | undefined {
  if (!bind?.length) return undefined;
  const binding: ActionBinding = {};
  for (const key of bind) {
    const value = params?.[key];
    if (typeof value !== 'string' || !value) return undefined;
    binding[key] = value;
  }
  return binding;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Stable JSON: key order must not change a digest. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareKeys(a, b));
  const body = entries
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
    .join(',');
  return `{${body}}`;
}

/**
 * The identity of one *attempt*: shape, bound resource and arguments together.
 *
 * It is what stops an agent's retry loop from filling a person's inbox with
 * three copies of the same question — the proposal is upserted on this digest,
 * so the second attempt finds the first one and gets the same id back.
 *
 * It is a hash and never a record: the arguments are read once, here, and the
 * bytes are thrown away. Storing them would put a catalog install's
 * `userInputs` — administrator passwords among them — in a table built to be
 * read by a person deciding whether to say yes.
 */
export function argsDigest(
  shape: string,
  binding: ActionBinding | undefined,
  body: unknown,
): string {
  return createHash('sha256')
    .update(canonical({ shape, binding: binding ?? null, body: body ?? null }))
    .digest('hex');
}

/** A concession, as far as matching is concerned. */
export interface ConcessionLike {
  action: string;
  binding?: ActionBinding | null;
  keyId?: string | null;
  revokedAt?: Date | null;
}

/**
 * Does this standing concession cover the call being made?
 *
 * Three conditions, each of which has to hold:
 *
 *  - it has not been revoked. The transport is stateless and this is read on
 *    every request, which is what makes a revoke stop future departures
 *    immediately and for free;
 *  - the concrete path matches the concession's route pattern, using
 *    `routeMatches` — the fence's own matcher, not a second one written here.
 *    Patterns only ever enter this table from a decorated route, so the `**`
 *    form the matcher also understands is not reachable by anybody;
 *  - every parameter the concession nailed down still has the same value.
 *    "Add nodes to control-cluster" is the pattern *plus* `{id: <that uuid>}`,
 *    and against another cluster's id it does not match — which is the whole
 *    difference between opening a door and opening a floor.
 *
 * The credential is compared too, and by id: a concession is given to *an
 * agent*, so a different key — even one the same person minted — starts from
 * proposals again.
 */
export function concessionCovers(
  concession: ConcessionLike,
  call: {
    method: string;
    path: string;
    binding?: ActionBinding;
    keyId?: string;
  },
): boolean {
  if (concession.revokedAt) return false;
  if (!concession.keyId || concession.keyId !== call.keyId) return false;
  const { verb, pattern } = splitShape(concession.action);
  if (verb !== call.method.toUpperCase()) return false;
  if (!routeMatches(pattern, call.path)) return false;
  for (const [key, value] of Object.entries(concession.binding ?? {})) {
    if (call.binding?.[key] !== value) return false;
  }
  return true;
}

/**
 * The sentence a person reads before answering, rendered from the declaration.
 *
 * The template names its parameters as `{id}` and they are filled from the
 * binding. It is stored on the proposal and copied verbatim onto the
 * concession, so the register later shows *what was agreed to* rather than a
 * reconstruction of it from a route pattern — which is the difference between
 * an informed revoke and a change of mind.
 *
 * Identifiers, not names: resolving `<uuid>` to "control-cluster" needs a
 * domain read, and a guard that reads the domain to phrase a question is a
 * guard that can fail for reasons that have nothing to do with the decision.
 * Whoever renders the request holds the id and can resolve the name.
 */
export function renderSentence(
  template: string,
  binding: ActionBinding | undefined,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    binding?.[key] ? binding[key] : whole,
  );
}

/**
 * A second clause of the sentence, worked out from the request body.
 *
 * `renderSentence` fills from route parameters, and a route parameter is the
 * only thing some actions are about. Others carry what they do in the body:
 * `POST /operating-context` has no parameters at all, and the level a note is
 * written at — the difference between "one cluster reads this" and "every
 * tenant and every guest of the demonstration reads this" — arrives there. A
 * person answering that request was being shown the verb and not the blast
 * radius.
 *
 * The contract on whatever is passed here is narrow and it is the reason this
 * is a function on the declaration rather than a domain lookup in the guard:
 *
 *  - it is **pure**. It reads no table and calls nothing. A guard that resolves
 *    a name to phrase a question is a guard that fails for reasons that have
 *    nothing to do with the decision — the same reason {@link renderSentence}
 *    fills in identifiers and never names;
 *  - it is fed an **unvalidated** body. Guards run before pipes, so the object
 *    is whatever was posted; a clause that cannot tell what it is looking at
 *    returns `undefined` and the sentence stays as it was;
 *  - it is read **once**, here, while the body is still in hand. The body is
 *    hashed and thrown away, so there is no later moment at which this could be
 *    recomputed — which is exactly the property wanted: the clause is fixed
 *    into the stored sentence before anybody reads it, and the concession
 *    copies that sentence verbatim. What was agreed to cannot be re-derived
 *    afterwards by a rule that has since changed its mind.
 *
 * A clause that throws is treated as a clause that had nothing to say. Losing
 * half a sentence is a worse answer than the whole one; refusing the call
 * because the prose failed would be a worse answer than either.
 */
export type SentenceClause = (body: unknown) => string | undefined;

export function composeSentence(
  template: string,
  binding: ActionBinding | undefined,
  clause: SentenceClause | undefined,
  body: unknown,
): string {
  const base = renderSentence(template, binding);
  if (!clause) return base;
  let extra: string | undefined;
  try {
    extra = clause(body);
  } catch {
    extra = undefined;
  }
  return extra?.trim() ? `${base} — ${extra.trim()}` : base;
}

/** Fill `:param` placeholders of a route pattern from the request's params. */
export function renderRoute(
  pattern: string,
  params: Record<string, unknown> | undefined,
): string | undefined {
  const out: string[] = [];
  for (const segment of pattern.split('/')) {
    if (!segment.startsWith(':')) {
      out.push(segment);
      continue;
    }
    const value = params?.[segment.slice(1)];
    if (typeof value !== 'string' || !value) return undefined;
    out.push(encodeURIComponent(value));
  }
  return out.join('/');
}

/**
 * Where a person goes to answer. One constant, because two places need to
 * agree on it and they are built in different rounds: the refusal that names it
 * and the panel that eventually serves it.
 */
export const PROPOSAL_DECISION_PATH = '/settings/agents/requests';

/**
 * What an agent is told when a request carries a price it is not shown.
 *
 * The estimate is a **route**, not a number: `estimateRef` names a pricing GET
 * that nobody has called yet — the guard deliberately never does — so at the
 * moment the refusal is written there is no figure to hand over, and there
 * never was one to summarise. What can be said truthfully is that a price
 * exists and who can see it, and saying that is the difference between an agent
 * that reports "I asked to add a node" and one that reports "I asked to add a
 * node, and it costs something I could not read".
 *
 * Said once, here, because two surfaces have to say the same thing and they
 * word their waits separately.
 */
export const ESTIMATE_WITHHELD_NOTE =
  'This request has a cost estimate attached and you are NOT being shown it — ' +
  'the person deciding reads it on that page. Tell the user this action has a ' +
  'price you cannot see; do not describe it as free and do not invent a figure.';

/** The fields a refusal carries so a client can present the wait as a wait. */
export interface ProposalRefusal {
  proposalId: string;
  action: string;
  sentence: string;
  offersAlways: boolean;
  decideUrl?: string;
  expiresAt?: string;
  /**
   * True when a price is attached to this request and is not in this object.
   *
   * The fact, never the pointer. `estimateRef` is an API path, and a path is
   * the one value a model turns into a call it cannot make: no tool publishes
   * an arbitrary GET, and one that did would hand a model every route its
   * credential can reach, around the tool list that decides what it may reach.
   * So the reference stays behind the guard and what leaves is the bit a client
   * can act on — including the agent, whose only honest action is to say so.
   */
  estimateWithheld: boolean;
}

/**
 * Read a proposal refusal off an API error body — and only a proposal refusal.
 *
 * Deliberately a narrow reader instead of a general "carry the body along":
 * the fields named here are the ones a client is meant to show a person, and a
 * generic bag would sooner or later carry a body that had no business leaving
 * the guard. Fail-closed: anything missing and this is not a proposal.
 *
 * `estimateRef` is read and **not kept**: a field is admitted here by what it
 * lets a reader do, and the pricing route lets a model do nothing but guess at
 * a call. Its existence is kept instead — see {@link ESTIMATE_WITHHELD_NOTE}.
 */
export function readProposalRefusal(
  body: unknown,
): ProposalRefusal | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (b.code !== ACTION_PROPOSAL_CODE) return undefined;
  if (typeof b.proposalId !== 'string' || typeof b.sentence !== 'string') {
    return undefined;
  }
  return {
    proposalId: b.proposalId,
    action: typeof b.action === 'string' ? b.action : '',
    sentence: b.sentence,
    offersAlways: b.offersAlways === true,
    decideUrl: typeof b.decideUrl === 'string' ? b.decideUrl : undefined,
    expiresAt: typeof b.expiresAt === 'string' ? b.expiresAt : undefined,
    estimateWithheld: typeof b.estimateRef === 'string' && !!b.estimateRef,
  };
}

/** Whether a proposal is still answerable. */
export function isProposalLive(
  proposal: { status: string; expiresAt?: Date | null },
  now = new Date(),
): boolean {
  if (proposal.status !== PROPOSAL_STATUS.PENDING) return false;
  return !proposal.expiresAt || proposal.expiresAt.getTime() > now.getTime();
}
