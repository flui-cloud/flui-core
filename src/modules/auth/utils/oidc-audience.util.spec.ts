import { carriesFluiAudience, currentOidcAudience } from './oidc-audience.util';

describe('the audience a Flui token must carry', () => {
  it('accepts a token whose audience includes the Flui client, in either shape', () => {
    expect(carriesFluiAudience(['a', 'flui-web'], 'flui-web')).toBe(true);
    expect(carriesFluiAudience('flui-web', 'flui-web')).toBe(true);
  });

  it('refuses a token issued to another app of the same identity provider', () => {
    expect(carriesFluiAudience(['customer-app'], 'flui-web')).toBe(false);
    expect(carriesFluiAudience(undefined, 'flui-web')).toBe(false);
  });

  it('refuses everything while no audience is known yet', () => {
    expect(carriesFluiAudience(['flui-web'], undefined)).toBe(false);
  });

  it('reads the value set while running, as the OIDC bootstrap leaves it', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(currentOidcAudience(env)).toBeUndefined();
    env.OIDC_AUDIENCE = ' flui-web ';
    expect(currentOidcAudience(env)).toBe('flui-web');
    expect(currentOidcAudience({ ZITADEL_AUDIENCE: 'legacy' })).toBe('legacy');
  });
});
