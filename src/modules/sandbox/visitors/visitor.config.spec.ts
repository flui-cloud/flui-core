import {
  isTryClient,
  loadVisitorConfig,
  publicApiBase,
  refusalUrl,
  visitorAuthConfig,
  visitorExpiry,
} from './visitor.config';

describe('the visitors’ configuration', () => {
  it('is shut unless both the demo and the entrance are on', () => {
    expect(loadVisitorConfig({}).enabled).toBe(false);
    expect(loadVisitorConfig({ SANDBOX_ENABLED: 'true' }).enabled).toBe(false);
    expect(
      loadVisitorConfig({ SANDBOX_VISITORS_ENABLED: 'true' }).enabled,
    ).toBe(false);
    expect(
      loadVisitorConfig({
        SANDBOX_ENABLED: 'true',
        SANDBOX_VISITORS_ENABLED: 'true',
      }).enabled,
    ).toBe(true);
  });

  it('has the documented defaults', () => {
    const config = loadVisitorConfig({});
    expect(config).toMatchObject({
      poolMin: 3,
      perIpHour: 10,
      cliPerIpHour: 3,
      globalPerMinute: 30,
      globalPerDay: 2000,
      idleMs: 48 * 3_600_000,
      maxMs: 168 * 3_600_000,
      turnstileSecret: null,
      turnstileSiteKey: null,
      ipHashKey: null,
    });
  });

  it('knows the two "try" applications by their client ids', () => {
    const env = {
      OIDC_VISITOR_CLIENT_ID: 'try-web',
      OIDC_VISITOR_CLI_CLIENT_ID: 'try-cli',
    };
    expect(isTryClient('try-web', env)).toBe(true);
    expect(isTryClient('try-cli', env)).toBe(true);
    expect(isTryClient('flui-web', env)).toBe(false);
    expect(isTryClient(null, env)).toBe(false);
    expect(isTryClient('', {})).toBe(false);
  });

  it('reads the API address the way the agent document does, without /api/v1', () => {
    expect(publicApiBase({})).toBe('http://localhost:3000');
    expect(publicApiBase({ PORT: '4000' })).toBe('http://localhost:4000');
    expect(publicApiBase({ PUBLIC_API_URL: 'https://api.example.test/' })).toBe(
      'https://api.example.test',
    );
    expect(
      publicApiBase({ API_BASE_URL: 'https://api.example.test/api/v1' }),
    ).toBe('https://api.example.test');
  });

  it('sends a refused visitor to the dashboard of the configuration, never elsewhere', () => {
    const config = loadVisitorConfig({
      SANDBOX_BASE_DOMAIN: 'http://localhost:4200',
    });
    expect(refusalUrl(config, 'no-admission')).toBe(
      'http://localhost:4200/login?visitor=refused&reason=no-admission',
    );
    expect(
      refusalUrl(
        loadVisitorConfig({ SANDBOX_BASE_DOMAIN: 'try.example.test' }),
        'closed',
      ),
    ).toBe('https://try.example.test/login?visitor=refused&reason=closed');
  });

  it('ends a visitor its maximum life after it arrived', () => {
    const config = loadVisitorConfig({ SANDBOX_VISITOR_MAX_HOURS: '2' });
    expect(visitorExpiry(new Date(0), config).getTime()).toBe(2 * 3_600_000);
  });

  it('tells the dashboard about visitors only while the entrance is open', () => {
    const env = {
      OIDC_VISITOR_CLIENT_ID: 'web-1',
      OIDC_VISITOR_CLI_CLIENT_ID: 'cli-1',
      TURNSTILE_SITE_KEY: 'site',
    };
    expect(visitorAuthConfig(env)).toEqual({});
    expect(
      visitorAuthConfig({
        ...env,
        SANDBOX_ENABLED: 'true',
        SANDBOX_VISITORS_ENABLED: 'true',
      }),
    ).toEqual({
      visitorClientId: 'web-1',
      visitorCliClientId: 'cli-1',
      turnstileSiteKey: 'site',
    });
    expect(
      visitorAuthConfig({
        SANDBOX_ENABLED: 'true',
        SANDBOX_VISITORS_ENABLED: 'true',
      }),
    ).toEqual({});
  });
});
