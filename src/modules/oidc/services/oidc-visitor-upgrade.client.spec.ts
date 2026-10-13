import { of, throwError } from 'rxjs';
import { OidcVisitorUpgradeClient } from './oidc-visitor-upgrade.client';

const build = (data: unknown = {}) => {
  const calls: Array<[string, string, unknown?]> = [];
  const respond = (method: string) =>
    jest.fn((url: string, bodyOrOpts?: unknown) => {
      calls.push([method, url.replace(/^https?:\/\/[^/]+/, ''), bodyOrOpts]);
      return of({ data });
    });
  const http = {
    post: respond('POST'),
    put: respond('PUT'),
    delete: respond('DELETE'),
  };
  return { client: new OidcVisitorUpgradeClient(http as never), http, calls };
};

describe('OidcVisitorUpgradeClient', () => {
  it('starts an intent and takes its id from the OAuth state', async () => {
    const { client, calls } = build({
      authUrl: 'https://github.com/login/oauth/authorize?state=intent-9&x=1',
    });

    const out = await client.startIntent('pat', 'auth.example.com', {
      idpId: 'idp-gh',
      successUrl: 'https://api/s',
      failureUrl: 'https://api/f',
    });

    expect(out).toEqual({
      intentId: 'intent-9',
      authUrl: 'https://github.com/login/oauth/authorize?state=intent-9&x=1',
    });
    expect(calls[0]).toEqual([
      'POST',
      '/v2/idp_intents',
      {
        idpId: 'idp-gh',
        urls: { successUrl: 'https://api/s', failureUrl: 'https://api/f' },
      },
    ]);
  });

  it('refuses an intent with no address to sign in at', async () => {
    const { client } = build({});

    await expect(
      client.startIntent('pat', 'h', {
        idpId: 'i',
        successUrl: 's',
        failureUrl: 'f',
      }),
    ).rejects.toThrow('no address');
  });

  it('reads back who signed in and whom the identity already belongs to', async () => {
    const { client, calls } = build({
      userId: 'zitadel-r1',
      idpInformation: { idpId: 'idp-gh', userId: 'gh-42', userName: 'mario' },
      addHumanUser: {
        email: { email: 'mario@example.com', isVerified: true },
        profile: { givenName: 'Mario', familyName: 'Rossi' },
      },
    });

    const out = await client.retrieveIntent('pat', 'h', 'intent-9', 'tok');

    expect(calls[0]).toEqual([
      'POST',
      '/v2/idp_intents/intent-9',
      { idpIntentToken: 'tok' },
    ]);
    expect(out).toEqual({
      idpId: 'idp-gh',
      externalUserId: 'gh-42',
      externalUserName: 'mario',
      linkedUserId: 'zitadel-r1',
      email: 'mario@example.com',
      emailVerified: true,
      givenName: 'Mario',
      familyName: 'Rossi',
      displayName: null,
    });
  });

  it('never calls an address verified when there is none', async () => {
    const { client } = build({
      idpInformation: { idpId: 'i', userId: 'u', userName: 'n' },
      addHumanUser: { email: { isVerified: true } },
    });

    const out = await client.retrieveIntent('pat', 'h', 'i', 't');

    expect(out.email).toBeNull();
    expect(out.emailVerified).toBe(false);
    expect(out.linkedUserId).toBeNull();
  });

  it('links, sets the address only as verified as the provider said, and clears the visitor mark', async () => {
    const { client, calls } = build();
    const link = {
      idpId: 'idp-gh',
      externalUserId: 'gh-42',
      externalUserName: 'mario',
    };

    await client.addIdpLink('pat', 'h', 'z1', link);
    await client.setEmail('pat', 'h', 'z1', 'a@b.c', true);
    await client.setEmail('pat', 'h', 'z1', 'a@b.c', false);
    await client.clearVisitorMark('pat', 'h', 'z1');
    await client.removeIdpLink('pat', 'h', 'z1', link);

    expect(
      calls.map(([m, u, b]) => [m, u, m === 'DELETE' ? undefined : b]),
    ).toEqual([
      [
        'POST',
        '/v2/users/z1/links',
        { idpLink: { idpId: 'idp-gh', userId: 'gh-42', userName: 'mario' } },
      ],
      ['POST', '/v2/users/z1/email', { email: 'a@b.c', isVerified: true }],
      ['POST', '/v2/users/z1/email', { email: 'a@b.c', sendCode: {} }],
      ['DELETE', '/management/v1/users/z1/metadata/flui.visitor', undefined],
      ['DELETE', '/v2/users/z1/links/idp-gh/gh-42', undefined],
    ]);
  });

  it('treats a mark or link already gone as done', async () => {
    const { client, http } = build();
    http.delete.mockReturnValue(
      throwError(() => ({ response: { status: 404 } })),
    );

    await expect(client.clearVisitorMark('pat', 'h', 'z1')).resolves.toBe(
      undefined,
    );
    await expect(
      client.removeIdpLink('pat', 'h', 'z1', {
        idpId: 'i',
        externalUserId: 'e',
      }),
    ).resolves.toBe(undefined);
  });
});
