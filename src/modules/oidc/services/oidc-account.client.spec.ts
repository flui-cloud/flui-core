import { of, throwError } from 'rxjs';
import { OidcAccountClient } from './oidc-account.client';

type Reply = unknown | ((url: string) => unknown);

const build = (replies: Record<string, Reply> = {}) => {
  const calls: Array<[string, string, unknown?]> = [];
  const respond = (method: string) =>
    jest.fn((url: string, bodyOrOpts?: unknown) => {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push([method, path, bodyOrOpts]);
      const key = `${method} ${path}`;
      const reply = key in replies ? replies[key] : {};
      if (reply instanceof Error) return throwError(() => reply);
      return of({ data: reply });
    });
  const http = {
    get: respond('GET'),
    post: respond('POST'),
    put: respond('PUT'),
    delete: respond('DELETE'),
  };
  return { client: new OidcAccountClient(http as never), calls };
};

const status = (code: number) =>
  Object.assign(new Error(`status ${code}`), { response: { status: code } });

describe('OidcAccountClient', () => {
  it('reads the user and its organisation', async () => {
    const { client } = build({
      'GET /v2/users/u-1': {
        details: { resourceOwner: 'org-1' },
        user: {
          userId: 'u-1',
          username: 'ada',
          human: {
            profile: {
              givenName: 'Ada',
              familyName: 'L',
              displayName: 'Ada L',
            },
            email: { email: 'ada@example.com', isVerified: true },
          },
        },
      },
    });
    expect(await client.getUser('pat', 'h', 'u-1')).toEqual({
      userId: 'u-1',
      orgId: 'org-1',
      userName: 'ada',
      email: 'ada@example.com',
      emailVerified: true,
      givenName: 'Ada',
      familyName: 'L',
      displayName: 'Ada L',
    });
  });

  it('strips the method type prefix', async () => {
    const { client } = build({
      'GET /v2/users/u-1/authentication_methods': {
        authMethodTypes: [
          'AUTHENTICATION_METHOD_TYPE_PASSWORD',
          'AUTHENTICATION_METHOD_TYPE_IDP',
        ],
      },
    });
    expect(await client.authMethods('pat', 'h', 'u-1')).toEqual([
      'PASSWORD',
      'IDP',
    ]);
  });

  it('reads the organisation’s password rules', async () => {
    const { client, calls } = build({
      'GET /v2/settings/password/complexity?ctx.orgId=org-1': {
        settings: { minLength: '12', requiresUppercase: true },
      },
    });
    expect(await client.passwordComplexity('pat', 'h', 'org-1')).toEqual({
      minLength: 12,
      requiresUppercase: true,
      requiresLowercase: false,
      requiresNumber: false,
      requiresSymbol: false,
    });
    expect(calls[0][1]).toBe(
      '/v2/settings/password/complexity?ctx.orgId=org-1',
    );
  });

  it('checks a password with a short-lived, named session it closes again', async () => {
    const { client, calls } = build({
      'POST /v2/sessions': { sessionId: 's-1', sessionToken: 't' },
    });
    expect(await client.checkPassword('pat', 'h', 'u-1', 'pw')).toBe('valid');
    expect(calls[0]).toEqual([
      'POST',
      '/v2/sessions',
      {
        checks: { user: { userId: 'u-1' }, password: { password: 'pw' } },
        lifetime: '30s',
        userAgent: { description: 'Flui password check' },
      },
    ]);
    expect(calls[1][0]).toBe('DELETE');
    expect(calls[1][1]).toBe('/v2/sessions/s-1');
  });

  it('still answers when the check session cannot be closed, and says so', async () => {
    const { client } = build({
      'POST /v2/sessions': { sessionId: 's-1' },
      'DELETE /v2/sessions/s-1': status(500),
    });
    const warn = jest
      .spyOn(
        (client as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    expect(await client.checkPassword('pat', 'h', 'u-1', 'pw')).toBe('valid');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('s-1'));
  });

  it('tells a wrong password from a locked or deactivated account, and throws on anything else', async () => {
    const wrong = build({ 'POST /v2/sessions': status(400) });
    expect(await wrong.client.checkPassword('pat', 'h', 'u-1', 'x')).toBe(
      'invalid',
    );
    for (const message of [
      'User is locked (COMMAND-SAfd2)',
      'Errors.User.NotActive',
      'failed precondition',
    ]) {
      const locked = build({
        'POST /v2/sessions': Object.assign(status(400), {
          response: { status: 400, data: { message } },
        }),
      });
      expect(await locked.client.checkPassword('pat', 'h', 'u-1', 'x')).toBe(
        'locked',
      );
    }
    const broken = build({ 'POST /v2/sessions': status(403) });
    await expect(
      broken.client.checkPassword('pat', 'h', 'u-1', 'x'),
    ).rejects.toThrow('status 403');
  });

  it('sends the current password with the new one', async () => {
    const { client, calls } = build();
    await client.setPassword('pat', 'h', 'u-1', 'old', 'new');
    expect(calls[0]).toEqual([
      'POST',
      '/v2/users/u-1/password',
      {
        newPassword: { password: 'new', changeRequired: false },
        currentPassword: 'old',
      },
    ]);
  });

  it('reads second factors from the management API on a provider without the v2 listing', async () => {
    const { client } = build({
      'POST /v2/users/u-1/authentication_factors/_search': status(404),
      'POST /management/v1/users/u-1/auth_factors/_search': {
        result: [
          { state: 'AUTH_FACTOR_STATE_READY', otp: {} },
          {
            state: 'AUTH_FACTOR_STATE_READY',
            u2f: { id: 'k-1', name: 'YubiKey' },
          },
        ],
      },
    });
    expect(await client.secondFactors('pat', 'h', 'u-1')).toEqual({
      totp: true,
      otpSms: false,
      otpEmail: false,
      securityKeys: [{ id: 'k-1', name: 'YubiKey', ready: true }],
    });
  });

  it('lists links and passkeys in its own shape', async () => {
    const { client } = build({
      'POST /v2/users/u-1/links/_search': {
        result: [{ idpId: 'gh', userId: 'ext-1', userName: 'ada' }],
      },
      'POST /v2/users/u-1/passkeys/_search': {
        result: [{ id: 'p-1', name: 'Mac', state: 'AUTH_FACTOR_STATE_READY' }],
      },
    });
    expect(await client.listIdpLinks('pat', 'h', 'u-1')).toEqual([
      { idpId: 'gh', externalUserId: 'ext-1', externalUserName: 'ada' },
    ]);
    expect(await client.listPasskeys('pat', 'h', 'u-1')).toEqual([
      { id: 'p-1', name: 'Mac', ready: true },
    ]);
  });

  it('removes on the user it is given, with every segment encoded', async () => {
    const { client, calls } = build();
    await client.removeIdpLink('pat', 'h', 'u-1', {
      idpId: 'a/b',
      externalUserId: 'c d',
    });
    expect(calls[0][1]).toBe('/v2/users/u-1/links/a%2Fb/c%20d');
  });
});
