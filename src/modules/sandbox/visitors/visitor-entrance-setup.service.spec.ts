jest.mock('@kubernetes/client-node', () => ({}));

import { VisitorEntranceSetupService } from './visitor-entrance-setup.service';
import { loadVisitorConfig } from './visitor.config';

describe('VisitorEntranceSetupService', () => {
  const ENV = {
    SANDBOX_ENABLED: 'true',
    SANDBOX_VISITORS_ENABLED: 'true',
    SANDBOX_BASE_DOMAIN: 'http://localhost:4200',
    PUBLIC_API_URL: 'http://localhost:3000',
    ZITADEL_SERVICE_ACCOUNT_PAT: 'service-pat',
    OIDC_ISSUER: 'https://auth.example.test',
  };

  const build = (
    env: Record<string, string> = ENV,
    project: unknown = { id: 'p1' },
  ) => {
    const admin = {
      findProjectByName: jest.fn(async () => project),
      findOidcAppByName: jest.fn(
        async (_p: string, _h: string, _id: string, name: string) =>
          name === 'flui-try-web'
            ? { appId: 'a-web', clientId: 'c-web' }
            : null,
      ),
    };
    const login = {
      ensureTryApp: jest.fn(
        async (
          _p: string,
          _h: string,
          _id: string,
          spec: { name: string },
          existing: unknown,
        ) => existing ?? { appId: 'a-cli', clientId: `c-${spec.name}` },
      ),
    };
    const loginClient = {
      ensure: jest.fn(async () => undefined),
      rememberTryClients: jest.fn(async () => undefined),
    };
    const service = new VisitorEntranceSetupService(
      loadVisitorConfig(env),
      admin as never,
      login as never,
      loginClient as never,
      {
        createQueryRunner: () => ({
          connect: async () => undefined,
          query: async () => [],
          release: async () => undefined,
        }),
      } as never,
    );
    return { service, admin, login, loginClient };
  };

  it('prepares the login credential and both try apps, pointing their sign-in at Flui', async () => {
    const t = build();
    const env: NodeJS.ProcessEnv = { ...ENV };
    expect(await t.service.setUp(env)).toBe(true);
    expect(t.loginClient.ensure).toHaveBeenCalledWith({
      pat: 'service-pat',
      host: 'auth.example.test',
    });
    const [web, cli] = t.login.ensureTryApp.mock.calls.map(
      (c) => c[3] as unknown as Record<string, unknown>,
    );
    expect(web).toEqual({
      name: 'flui-try-web',
      kind: 'web',
      redirectUris: ['http://localhost:4200/auth/callback'],
      postLogoutRedirectUris: [
        'http://localhost:4200',
        'http://localhost:4200/login?loggedOut=true',
      ],
      devMode: true,
      loginBaseUri: 'http://localhost:3000/api/v1/sandbox/visitor',
    });
    expect(cli).toMatchObject({
      name: 'flui-try-cli',
      kind: 'cli',
      devMode: true,
    });
    expect((cli.redirectUris as string[])[0]).toMatch(
      /^http:\/\/localhost:\d+\/callback$/,
    );
    expect(env.OIDC_VISITOR_CLIENT_ID).toBe('c-web');
    expect(env.OIDC_VISITOR_CLI_CLIENT_ID).toBe('c-flui-try-cli');
    expect(t.loginClient.rememberTryClients).toHaveBeenCalledWith(
      'c-web',
      'c-flui-try-cli',
    );
  });

  it('leaves development mode off when every address is https', async () => {
    const env = {
      ...ENV,
      SANDBOX_BASE_DOMAIN: 'try.example.test',
      PUBLIC_API_URL: 'https://api.example.test',
    };
    const t = build(env);
    await t.service.setUp({ ...env });
    expect(
      (t.login.ensureTryApp.mock.calls[0][3] as unknown as { devMode: boolean })
        .devMode,
    ).toBe(false);
  });

  it('does nothing without a service account or a Flui project', async () => {
    expect(
      await build().service.setUp({ ...ENV, ZITADEL_SERVICE_ACCOUNT_PAT: '' }),
    ).toBe(false);
    expect(await build(ENV, null).service.setUp({ ...ENV })).toBe(false);
  });
});
