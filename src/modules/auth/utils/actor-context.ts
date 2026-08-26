import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What kind of principal is acting, when "which user" is no longer the whole
 * answer.
 *
 * A Flui API key is issued *as* its principal and carries that principal's
 * `isAdmin`, so a row that records only `userId` cannot say whether the person
 * did something or something acting on their behalf did. The three values are
 * derived, never stored on a credential:
 *
 *  - `agent` — the credential declares an `mcp:*` ceiling, **or** the call came
 *    through an agentic surface (`actor-surface.ts`). The prefix is already the
 *    discriminant everywhere else (`mcpScopesOf`, `credentialCeiling`,
 *    `McpScopeResolver`), and reusing it means a new source of agent scopes —
 *    the identity provider's project roles, say — is classified without anybody
 *    remembering to set a flag. The surface is the half the ceiling cannot
 *    reach: the portal's assistant runs on the person's own session and is an
 *    agent all the same, because a model wrote the arguments;
 *  - `key` — an API key that declares no ceiling: the CLI key, the service
 *    identities. Not an agent, not a browser either;
 *  - `user` — everything else, i.e. an interactive session.
 */
export type ActorKind = 'user' | 'key' | 'agent';

/** Who acted, beside the user id every row already carries. */
export interface Actor {
  kind: ActorKind;
  /** `api_keys.id`, when a key authenticated the request. Never the key. */
  keyId?: string;
}

/**
 * The actor of the request currently being served.
 *
 * It exists because of a count: 122 places build an
 * `InfrastructureOperationEntity`, in 24 files, and threading an argument
 * through all of them to reach a column would be 122 chances to forget one —
 * and a forgotten one writes a row that silently claims a person did what an
 * agent did. The store is written once, where the credential is already known
 * (the auth guard), and read once, where the row is already being written (the
 * entity's own insert hook).
 *
 * The store object is created empty by the middleware and filled by the guard,
 * which runs later in the same context: `AsyncLocalStorage.run` has to wrap the
 * whole request, and the actor is not known yet at that point. Mutating a
 * shared store is the standard shape for exactly this reason.
 *
 * Nothing outside a request has a context, and that is correct: a queue worker
 * acts for nobody in particular, so the columns stay null rather than
 * inheriting whichever request happened to enqueue the job.
 */
const storage = new AsyncLocalStorage<{ actor?: Actor; grantId?: string }>();

/** Opens an empty context for one request. */
export function runWithActorContext<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** Opens a context that already knows its actor — entry points without a guard, and tests. */
export function runAsActor<T>(actor: Actor, fn: () => T): T {
  return storage.run({ actor }, fn);
}

/** No-op outside a request context, so a background path can call it blindly. */
export function setCurrentActor(actor: Actor): void {
  const store = storage.getStore();
  if (store) store.actor = actor;
}

export function currentActor(): Actor | undefined {
  return storage.getStore()?.actor;
}

/**
 * Which standing concession, or which one-off approval, let this request past
 * the action cycle.
 *
 * It rides the same context as the actor instead of getting a mechanism of its
 * own, because it has the same problem and the same shape: the row that needs
 * it is built in one of a hundred-odd places, and it is written once where the
 * decision was actually made — the guard — and read once where the row is
 * written. It is the join behind the only honest revoke dialog: *these three
 * operations started under the permission you are taking back, and they are
 * still running.*
 */
export function setCurrentGrant(grantId: string | undefined): void {
  const store = storage.getStore();
  if (store) store.grantId = grantId;
}

export function currentGrantId(): string | undefined {
  return storage.getStore()?.grantId;
}
