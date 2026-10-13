import { VisitorLoginService, authRequestIdOf } from './visitor-login.service';
import { loadVisitorConfig } from './visitor.config';

const ENV = {
  SANDBOX_ENABLED: 'true',
  SANDBOX_VISITORS_ENABLED: 'true',
  SANDBOX_BASE_DOMAIN: 'http://localhost:4200',
  ZITADEL_SERVICE_ACCOUNT_PAT: 'service-pat',
  OIDC_ISSUER: 'https://auth.example.test',
  OIDC_VISITOR_CLIENT_ID: 'web-client',
  OIDC_VISITOR_CLI_CLIENT_ID: 'cli-client',
};

const refused = (reason: string) =>
  `http://localhost:4200/login?visitor=refused&reason=${reason}`;

describe('VisitorLoginService', () => {
  const build = (
    over: {
      env?: Record<string, string>;
      clientId?: string;
      admitted?: boolean;
      callbackError?: unknown;
      token?: string | null;
    } = {},
  ) => {
    const env = over.env ?? ENV;
    const login = {
      getAuthRequest: jest.fn(async () => ({
        id: 'V2_1',
        clientId: over.clientId ?? 'web-client',
        loginHint: 'nonce-1',
      })),
      createCallback: jest.fn(async () => {
        if (over.callbackError) throw over.callbackError;
        return 'http://localhost:4200/auth/callback?code=abc&state=s';
      }),
    };
    const loginClient = {
      token: jest.fn(async () =>
        over.token === undefined ? 'login-pat' : over.token,
      ),
      forget: jest.fn(),
      ensure: jest.fn(async () => undefined),
    };
    const admissions = {
      consume: jest.fn(async () =>
        over.admitted === false ? null : { ipHash: 'h' },
      ),
    };
    const pool = {
      enter: jest.fn(async () => ({
        userId: 'u-1',
        session: { sessionId: 's', sessionToken: 't' },
        fromPool: true,
      })),
    };
    const refusals = { note: jest.fn(async () => undefined) };
    const service = new VisitorLoginService(
      loadVisitorConfig(env),
      login as never,
      loginClient as never,
      admissions as never,
      pool as never,
      refusals as never,
    );
    return {
      enter: (id: string | null = 'V2_1') => service.enter(id, env),
      refusals,
      login,
      loginClient,
      admissions,
      pool,
    };
  };

  it('reads the auth request id the provider sends, and nothing else', () => {
    expect(authRequestIdOf('V2_abc-1', undefined)).toBe('V2_abc-1');
    expect(authRequestIdOf(undefined, 'oidc_V2_abc')).toBe('V2_abc');
    expect(authRequestIdOf('https://evil.test', undefined)).toBeNull();
    expect(authRequestIdOf('V2_a/../b', undefined)).toBeNull();
    expect(authRequestIdOf(undefined, undefined)).toBeNull();
  });

  it('signs a visitor in with the login credential and follows the provider', async () => {
    const t = build();
    expect(await t.enter()).toBe(
      'http://localhost:4200/auth/callback?code=abc&state=s',
    );
    expect(t.login.getAuthRequest).toHaveBeenCalledWith(
      'login-pat',
      'auth.example.test',
      'V2_1',
    );
    expect(t.admissions.consume).toHaveBeenCalledWith('nonce-1', false);
    expect(t.pool.enter).toHaveBeenCalledWith('h');
    expect(t.login.createCallback).toHaveBeenCalledWith(
      'login-pat',
      'auth.example.test',
      'V2_1',
      {
        sessionId: 's',
        sessionToken: 't',
      },
    );
  });

  it('asks the command line for a command-line ticket', async () => {
    const t = build({ clientId: 'cli-client' });
    await t.enter();
    expect(t.admissions.consume).toHaveBeenCalledWith('nonce-1', true);
  });

  it('refuses while shut, without asking anyone', async () => {
    const t = build({ env: { ...ENV, SANDBOX_VISITORS_ENABLED: 'false' } });
    expect(await t.enter()).toBe(refused('closed'));
    expect(t.login.getAuthRequest).not.toHaveBeenCalled();
  });

  it('refuses a malformed request and an application that is not a try app', async () => {
    expect(await build().enter(null)).toBe(refused('invalid'));
    const other = build({ clientId: 'flui-web' });
    expect(await other.enter()).toBe(refused('invalid'));
    expect(other.admissions.consume).not.toHaveBeenCalled();
  });

  it('refuses without a valid ticket, and makes no visitor', async () => {
    const t = build({ admitted: false });
    expect(await t.enter()).toBe(refused('no-admission'));
    expect(t.pool.enter).not.toHaveBeenCalled();
  });

  it('refuses while the login credential is not ready', async () => {
    expect(await build({ token: null }).enter()).toBe(refused('closed'));
  });

  it('sends a failure back to sign-in, and renews a refused credential', async () => {
    const t = build({
      callbackError: Object.assign(new Error('no'), {
        response: { status: 403 },
      }),
    });
    expect(await t.enter()).toBe(refused('error'));
    expect(t.loginClient.forget).toHaveBeenCalled();
    expect(t.loginClient.ensure).toHaveBeenCalled();
  });

  it('counts every refusal by its reason', async () => {
    const t = build({ admitted: false });
    await t.enter();
    expect(t.refusals.note).toHaveBeenCalledWith('no-admission');
    const bad = build({ clientId: 'other' });
    await bad.enter();
    expect(bad.refusals.note).toHaveBeenCalledWith('invalid');
  });
});
