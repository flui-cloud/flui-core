import { Actor } from './actor-context';
import { mcpScopesOf, ScopedCredential } from './credential-ceiling.util';
import {
  AgentSurface,
  ASSISTANT_AGENT_KEY_ID,
  agentSurfaceOf,
} from './actor-surface';
import {
  CURRENT_API_KEY_ID,
  RequestWithApiKey,
} from '../strategies/api-key.strategy';

/**
 * The one rule that turns a credential into an actor, written once because it
 * is asked from three places (the auth guard, the MCP endpoint, the assistant
 * endpoint) and three copies of it would eventually disagree.
 *
 * Both inputs already exist at every call site: the principal is `req.user`,
 * and the key id is the one the guard parked on the request. Nothing new is
 * derived from a credential and nothing is stored on one — which is why an
 * `mcp:*` ceiling that arrives through the identity provider's project roles,
 * with no `api_keys` row behind it at all, still classifies as an agent.
 *
 * **The third input is the surface**, and it is the half that was missing. The
 * ceiling answers "is this credential an agent's"; it cannot answer "did a
 * model write these arguments", and for the in-product assistant those two
 * questions give opposite answers — the person's own browser session, driving
 * the same tools. Either source is enough on its own: a key that declares a
 * ceiling is an agent wherever it is presented (decision 74), and a call made
 * by a tool is an agent's call whatever credential it carries.
 */
export function actorOf(
  credential: ScopedCredential | undefined,
  keyId?: string,
  surface?: AgentSurface,
): Actor {
  if (mcpScopesOf(credential).length || surface) {
    // Preferring the real key row is what keeps an agent credential's standing
    // permissions attached to that credential even when it drives the
    // assistant. The fallback identity exists only where there is no key at
    // all — see ASSISTANT_AGENT_KEY_ID for why the MCP surface gets none.
    const id =
      keyId ?? (surface === 'assistant' ? ASSISTANT_AGENT_KEY_ID : undefined);
    return id ? { kind: 'agent', keyId: id } : { kind: 'agent' };
  }
  return keyId ? { kind: 'key', keyId } : { kind: 'user' };
}

/** The request's actor: its principal, whichever key row authenticated it, and the surface it came through. */
export function actorFromRequest(
  req: {
    user?: ScopedCredential;
    headers?: Record<string, unknown>;
  } & RequestWithApiKey,
): Actor {
  return actorOf(
    req.user,
    req[CURRENT_API_KEY_ID],
    agentSurfaceOf(req.headers),
  );
}
