import { Actor } from './actor-context';
import { mcpScopesOf, ScopedCredential } from './credential-ceiling.util';
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
 */
export function actorOf(
  credential: ScopedCredential | undefined,
  keyId?: string,
): Actor {
  if (mcpScopesOf(credential).length) {
    return keyId ? { kind: 'agent', keyId } : { kind: 'agent' };
  }
  return keyId ? { kind: 'key', keyId } : { kind: 'user' };
}

/** The request's actor: its principal, plus whichever key row authenticated it. */
export function actorFromRequest(
  req: { user?: ScopedCredential } & RequestWithApiKey,
): Actor {
  return actorOf(req.user, req[CURRENT_API_KEY_ID]);
}
