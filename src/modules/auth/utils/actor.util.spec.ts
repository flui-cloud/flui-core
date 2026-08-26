import { actorOf, actorFromRequest } from './actor.util';
import { CURRENT_API_KEY_ID } from '../strategies/api-key.strategy';
import {
  AGENT_SURFACE_HEADER,
  ASSISTANT_AGENT_KEY_ID,
  agentSurfaceHeader,
} from './actor-surface';

const KEY_ID = '11111111-2222-3333-4444-555555555555';

describe('actorOf', () => {
  it('calls a credential that declares mcp scopes an agent', () => {
    expect(actorOf({ scopes: ['mcp:app:read'] }, KEY_ID)).toEqual({
      kind: 'agent',
      keyId: KEY_ID,
    });
  });

  it('calls an unscoped key a key, not an agent', () => {
    // The CLI key and the service identities declare no ceiling. They are not a
    // browser session either, and a screen that showed them as "a person" would
    // be lying about `flui env create`.
    expect(actorOf({ scopes: undefined }, KEY_ID)).toEqual({
      kind: 'key',
      keyId: KEY_ID,
    });
  });

  it('calls a session with no key at all a user', () => {
    expect(actorOf({ scopes: ['openid', 'profile'] })).toEqual({
      kind: 'user',
    });
  });

  it('reads agent authority arriving as identity-provider project roles', () => {
    // Decision 112: `mcp:*` granted as a project role caps the account it is on,
    // key or no key. The classification follows the same discriminant the
    // ceiling does, so a second source needs no second rule.
    expect(actorOf({ roles: { 'mcp:app:read': {} } })).toEqual({
      kind: 'agent',
    });
  });

  it('is empty-safe', () => {
    expect(actorOf(undefined)).toEqual({ kind: 'user' });
  });
});

describe('actorFromRequest', () => {
  it('joins the principal with the key row the guard parked on the request', () => {
    const req = { user: { scopes: ['mcp:app:write'] } } as Record<
      string,
      unknown
    >;
    req[CURRENT_API_KEY_ID as unknown as string] = KEY_ID;
    expect(actorFromRequest(req as never)).toEqual({
      kind: 'agent',
      keyId: KEY_ID,
    });
  });

  it('says user when nothing authenticated by key', () => {
    expect(actorFromRequest({ user: { scopes: [] } } as never)).toEqual({
      kind: 'user',
    });
  });
});

/**
 * The assimilation, at the one line where it is decided.
 *
 * A person using the portal's assistant is authenticated with the same browser
 * session they read the dashboard with. Nothing about that credential says
 * "agent" and nothing should: what makes the call an agent's is that a model
 * chose its arguments, and the only thing that knows is the surface it came
 * through.
 */
describe('the surface, beside the credential', () => {
  const withSurface = (
    surface: 'assistant' | 'mcp',
    user: Record<string, unknown>,
    keyId?: string,
  ) => {
    const req: Record<string, unknown> = {
      user,
      headers: { [AGENT_SURFACE_HEADER]: agentSurfaceHeader(surface) },
    };
    if (keyId) req[CURRENT_API_KEY_ID as unknown as string] = keyId;
    return actorFromRequest(req as never);
  };

  it("calls a person's own session an agent when the assistant is what is calling", () => {
    // The measured gap: this exact credential used to classify `user`, so the
    // action cycle never saw it — while the same tools, writes included, ran
    // behind it.
    expect(withSurface('assistant', { scopes: ['openid', 'profile'] })).toEqual(
      {
        kind: 'agent',
        keyId: ASSISTANT_AGENT_KEY_ID,
      },
    );
  });

  it('gives the assistant an identity to hang a standing permission on', () => {
    // Without one it could only ever be told "once", and a copilot that asks
    // the same question every turn is worse than the state this replaces.
    expect(
      withSurface('assistant', { scopes: ['openid'] }).keyId,
    ).not.toBeUndefined();
  });

  it('keeps a real key row when one authenticated the person', () => {
    expect(withSurface('assistant', { scopes: ['openid'] }, KEY_ID)).toEqual({
      kind: 'agent',
      keyId: KEY_ID,
    });
  });

  it('invents no identity for a keyless MCP caller', () => {
    // Several distinct agent identities reach the product without a key row
    // (project roles from the identity provider). One shared name there would
    // merge grants that were given separately, so that surface gets none.
    expect(withSurface('mcp', { scopes: ['openid'] })).toEqual({
      kind: 'agent',
    });
  });

  it('leaves a request that declares no surface exactly as it was', () => {
    expect(
      actorFromRequest({
        user: { scopes: ['openid', 'profile'] },
        headers: { 'user-agent': 'Mozilla/5.0' },
      } as never),
    ).toEqual({ kind: 'user' });
  });

  it('does not take a client at its word', () => {
    expect(
      actorFromRequest({
        user: { scopes: ['openid'] },
        headers: { [AGENT_SURFACE_HEADER]: 'assistant' },
      } as never),
    ).toEqual({ kind: 'user' });
  });

  it('still classifies an agent credential with no surface at all', () => {
    expect(actorOf({ scopes: ['mcp:app:write'] }, KEY_ID)).toEqual({
      kind: 'agent',
      keyId: KEY_ID,
    });
  });
});
