import { of, throwError } from 'rxjs';
import {
  OidcVisitorLoginClient,
  TryAppSpec,
} from './oidc-visitor-login.client';

describe('OidcVisitorLoginClient', () => {
  const build = (answers: Record<string, unknown> = {}) => {
    const calls: Array<{
      verb: string;
      url: string;
      body?: unknown;
      headers?: unknown;
    }> = [];
    const respond = (verb: string) =>
      jest.fn((url: string, a?: unknown, b?: unknown) => {
        const bodiless = verb === 'get' || verb === 'delete';
        const body = bodiless ? undefined : a;
        const opts = (bodiless ? a : b) as { headers?: unknown };
        calls.push({ verb, url, body, headers: opts?.headers });
        const answer =
          answers[`${verb} ${url.replace(/^https?:\/\/[^/]+/, '')}`];
        if (answer instanceof Error) return throwError(() => answer);
        return of({ data: answer ?? {} });
      });
    const http = {
      get: respond('get'),
      post: respond('post'),
      put: respond('put'),
      delete: respond('delete'),
    };
    return { client: new OidcVisitorLoginClient(http as never), calls };
  };

  const spec: TryAppSpec = {
    name: 'flui-try-web',
    kind: 'web',
    redirectUris: ['http://localhost:4200/auth/callback'],
    postLogoutRedirectUris: ['http://localhost:4200'],
    devMode: true,
    loginBaseUri: 'http://localhost:3000/api/v1/sandbox/visitor',
  };

  it('creates a try app that hands its sign-in to Flui, with PKCE and refresh', async () => {
    const { client, calls } = build({
      'post /management/v1/projects/p1/apps/oidc': {
        appId: 'a1',
        clientId: 'c1',
      },
    });
    expect(
      await client.ensureTryApp('pat', 'auth.test', 'p1', spec, null),
    ).toEqual({
      appId: 'a1',
      clientId: 'c1',
    });
    expect(calls[0].body).toMatchObject({
      name: 'flui-try-web',
      appType: 'OIDC_APP_TYPE_USER_AGENT',
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
      grantTypes: [
        'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
        'OIDC_GRANT_TYPE_REFRESH_TOKEN',
      ],
      devMode: true,
      loginVersion: { loginV2: { baseUri: spec.loginBaseUri } },
    });
    expect(calls[0].headers).toMatchObject({
      Host: 'auth.test',
      Authorization: 'Bearer pat',
    });
  });

  it('keeps the addresses already on an app and adds its own', async () => {
    const { client, calls } = build({
      'get /management/v1/projects/p1/apps/a1': {
        app: {
          oidcConfig: {
            redirectUris: ['https://app.test/auth/callback'],
            devMode: false,
          },
        },
      },
    });
    await client.ensureTryApp('pat', 'auth.test', 'p1', spec, {
      appId: 'a1',
      clientId: 'c1',
    });
    const put = calls.find((c) => c.verb === 'put')!;
    expect(put.url).toContain('/apps/a1/oidc_config');
    expect((put.body as { redirectUris: string[] }).redirectUris).toEqual([
      'https://app.test/auth/callback',
      'http://localhost:4200/auth/callback',
    ]);
  });

  it('changes nothing on an app that is already right', async () => {
    const { client, calls } = build({
      'get /management/v1/projects/p1/apps/a1': {
        app: {
          oidcConfig: {
            redirectUris: spec.redirectUris,
            postLogoutRedirectUris: spec.postLogoutRedirectUris,
            grantTypes: [
              'OIDC_GRANT_TYPE_REFRESH_TOKEN',
              'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
            ],
            devMode: true,
            loginVersion: { loginV2: { baseUri: spec.loginBaseUri } },
          },
        },
      },
    });
    await client.ensureTryApp('pat', 'auth.test', 'p1', spec, {
      appId: 'a1',
      clientId: 'c1',
    });
    expect(calls.some((c) => c.verb === 'put')).toBe(false);
  });

  it('hands a session to an auth request and returns where the provider sends the browser', async () => {
    const { client, calls } = build({
      'post /v2/oidc/auth_requests/V2_1': {
        callbackUrl: 'http://localhost:4200/auth/callback?code=x',
      },
      'get /v2/oidc/auth_requests/V2_1': {
        authRequest: { id: 'V2_1', clientId: 'c1', loginHint: 'n' },
      },
    });
    expect(await client.getAuthRequest('lpat', 'auth.test', 'V2_1')).toEqual({
      id: 'V2_1',
      clientId: 'c1',
      loginHint: 'n',
    });
    expect(
      await client.createCallback('lpat', 'auth.test', 'V2_1', {
        sessionId: 's',
        sessionToken: 't',
      }),
    ).toBe('http://localhost:4200/auth/callback?code=x');
    expect(calls[1].body).toEqual({
      session: { sessionId: 's', sessionToken: 't' },
    });
  });

  describe('a user the provider has not finished writing', () => {
    const notFound = Object.assign(new Error('not found'), {
      response: { status: 404 },
    });
    const withPosts = (answers: unknown[]) => {
      const post = jest.fn(() => {
        const next = answers.shift();
        return next instanceof Error
          ? throwError(() => next)
          : of({ data: next });
      });
      return {
        client: new OidcVisitorLoginClient({ post } as never),
        post,
      };
    };

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('waits and opens the session once the user is readable', async () => {
      const { client, post } = withPosts([
        notFound,
        notFound,
        { sessionId: 's', sessionToken: 't' },
      ]);
      const opened = client.createSession('lpat', 'auth.test', 'u1', 'pw');
      await jest.advanceTimersByTimeAsync(1000);
      await expect(opened).resolves.toEqual({
        sessionId: 's',
        sessionToken: 't',
      });
      expect(post).toHaveBeenCalledTimes(3);
    });

    it('gives up after the last wait', async () => {
      const { client, post } = withPosts(Array(6).fill(notFound));
      const opened = client.createSession('lpat', 'auth.test', 'u1', 'pw');
      const settled = expect(opened).rejects.toBe(notFound);
      await jest.advanceTimersByTimeAsync(8000);
      await settled;
      expect(post).toHaveBeenCalledTimes(6);
    });

    it('does not wait on any other refusal', async () => {
      const refused = Object.assign(new Error('no'), {
        response: { status: 400 },
      });
      const { client, post } = withPosts([refused]);
      await expect(
        client.createSession('lpat', 'auth.test', 'u1', 'pw'),
      ).rejects.toBe(refused);
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  it('opens a session with the user and password checks', async () => {
    const { client, calls } = build({
      'post /v2/sessions': { sessionId: 's', sessionToken: 't' },
    });
    expect(await client.createSession('lpat', 'auth.test', 'u1', 'pw')).toEqual(
      {
        sessionId: 's',
        sessionToken: 't',
      },
    );
    expect(calls[0].body).toEqual({
      checks: { user: { userId: 'u1' }, password: { password: 'pw' } },
    });
  });

  it('makes a visitor whose password is never asked to change, and marks it', async () => {
    const { client, calls } = build({
      'post /v2/users/human': { userId: 'u1' },
    });
    await client.createHuman('pat', 'auth.test', {
      userName: 'visitor-1',
      email: 'v@x.invalid',
      password: 'pw',
    });
    expect(calls[0].body).toMatchObject({
      username: 'visitor-1',
      email: { email: 'v@x.invalid', isVerified: true },
      password: { password: 'pw', changeRequired: false },
      metadata: [{ key: 'flui.visitor', value: 'MQ==' }],
    });
  });

  it('accepts an existing membership, and tells a refused token apart from an outage', async () => {
    const conflict = Object.assign(new Error('exists'), {
      response: { status: 409 },
    });
    const refused = Object.assign(new Error('no'), {
      response: { status: 401 },
    });
    const down = Object.assign(new Error('down'), {
      response: { status: 503 },
    });
    await expect(
      build({ 'post /admin/v1/members': conflict }).client.addInstanceMember(
        'pat',
        'h',
        'u',
        ['IAM_LOGIN_CLIENT'],
      ),
    ).resolves.toBeUndefined();
    expect(
      await build({ 'get /auth/v1/users/me': refused }).client.acceptsToken(
        'p',
        'h',
      ),
    ).toBe(false);
    await expect(
      build({ 'get /auth/v1/users/me': down }).client.acceptsToken('p', 'h'),
    ).rejects.toThrow('down');
  });

  describe('the login-client credential', () => {
    it('mints a token that expires, and says its id', async () => {
      const { client, calls } = build({
        'post /management/v1/users/m1/pats': { tokenId: 't1', token: 'pat' },
      });
      const at = new Date('2027-01-01T00:00:00Z');
      expect(
        await client.createPersonalAccessToken('p', 'h', 'm1', at),
      ).toEqual({ tokenId: 't1', token: 'pat' });
      expect(calls[0].body).toEqual({
        expirationDate: '2027-01-01T00:00:00.000Z',
      });
    });

    it('lists the ids of a user’s tokens', async () => {
      const { client } = build({
        'post /management/v1/users/m1/pats/_search': {
          result: [{ id: 'a' }, { id: 'b' }, {}],
        },
      });
      expect(await client.listPersonalAccessTokenIds('p', 'h', 'm1')).toEqual([
        'a',
        'b',
      ]);
    });

    it('deletes a token, leaving one already gone alone', async () => {
      const gone = Object.assign(new Error('nf'), {
        response: { status: 404 },
      });
      const { client, calls } = build({
        'delete /management/v1/users/m1/pats/t-gone': gone,
      });
      await client.deletePersonalAccessToken('p', 'h', 'm1', 't1');
      await client.deletePersonalAccessToken('p', 'h', 'm1', 't-gone');
      expect(calls.map((c) => `${c.verb} ${c.url}`)).toEqual([
        expect.stringMatching(/^delete .*pats\/t1$/),
        expect.stringMatching(/pats\/t-gone$/),
      ]);
    });
  });
});
