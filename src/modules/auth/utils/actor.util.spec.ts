import { actorOf, actorFromRequest } from './actor.util';
import { CURRENT_API_KEY_ID } from '../strategies/api-key.strategy';

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
