import {
  INTENT_CALLBACK_PATH,
  ProviderState,
  callbackUrlOf,
  connectionFrom,
  currentIdpId,
  statusOf,
} from './demo-sign-in.core';

const state = (existing: ProviderState['existing'], idpIds: string[] = []) =>
  ({
    policy: { idpIds } as unknown as ProviderState['policy'],
    existing,
  }) as ProviderState;

const record = (idpId: string | null) => ({
  clientId: 'client',
  idpId,
  connectedAt: null,
  connectedBy: null,
  disconnectedAt: null,
});

describe('demo sign-in helpers', () => {
  it('reaches the identity provider only with both a token and an issuer', () => {
    expect(connectionFrom({ OIDC_ISSUER: 'https://auth.example' })).toBeNull();
    expect(
      connectionFrom({
        ZITADEL_SERVICE_ACCOUNT_PAT: 'pat',
        OIDC_ISSUER: 'https://auth.example',
      }),
    ).toEqual({
      pat: 'pat',
      host: 'auth.example',
      issuer: 'https://auth.example',
    });
  });

  it('builds both callback addresses without a doubled slash', () => {
    const conn = {
      pat: 'p',
      host: 'auth.example',
      issuer: 'https://auth.example/',
    };
    expect(callbackUrlOf(conn)).toBe(
      'https://auth.example/ui/login/login/externalidp/callback',
    );
    expect(callbackUrlOf(conn, INTENT_CALLBACK_PATH)).toBe(
      'https://auth.example/idps/callback',
    );
  });

  it('prefers the recorded provider while it still exists, else finds it by name', () => {
    const existing = [
      { id: 'a', name: 'GitHub', type: 'github' },
      { id: 'b', name: 'Google', type: 'google' },
    ];
    expect(currentIdpId('github', record('a'), state(existing))).toBe('a');
    expect(currentIdpId('github', record('gone'), state(existing))).toBe('a');
    expect(currentIdpId('github', null, state([]))).toBeNull();
  });

  it('reports a recorded provider as connected only while the identity provider holds it', () => {
    const existing = [{ id: 'a', name: 'GitHub', type: 'github' }];
    const live = statusOf('github', record('a'), state(existing, ['a']), {});
    expect(live).toMatchObject({
      connected: true,
      source: 'flui',
      onSignInPage: true,
    });
    const gone = statusOf('github', record('a'), state([]), {});
    expect(gone).toMatchObject({ connected: false, source: null });
  });
});
