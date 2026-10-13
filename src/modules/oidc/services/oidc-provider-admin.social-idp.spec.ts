jest.mock('@kubernetes/client-node', () => ({}));

import { of, throwError } from 'rxjs';
import { OidcProviderAdminClient } from './oidc-provider-admin.service';

describe('social sign-in on the identity provider', () => {
  const build = () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const record =
      (method: string) =>
      (url: string, bodyOrOptions?: unknown, _options?: unknown) => {
        calls.push({
          method,
          url,
          ...(method === 'put' || method === 'post'
            ? { body: bodyOrOptions }
            : {}),
        });
        return of({ data: { id: 'idp-1' } });
      };
    const http = {
      post: jest.fn(record('post')),
      put: jest.fn(record('put')),
      delete: jest.fn(record('delete')),
      get: jest.fn(record('get')),
    };
    return { client: new OidcProviderAdminClient(http as never), calls, http };
  };

  const params = { name: 'GitHub', clientId: 'id', clientSecret: 'secret' };

  it('updates an existing GitHub sign-in in place, with the same options it was created with', async () => {
    const { client, calls } = build();

    await client.updateSocialIdentityProvider(
      'pat',
      'auth.example',
      'github',
      'idp-1',
      params,
    );

    expect(calls).toEqual([
      {
        method: 'put',
        url: expect.stringMatching(/\/management\/v1\/idps\/github\/idp-1$/),
        body: {
          name: 'GitHub',
          clientId: 'id',
          clientSecret: 'secret',
          scopes: ['read:user', 'user:email'],
          providerOptions: {
            isLinkingAllowed: false,
            isCreationAllowed: true,
            isAutoCreation: true,
            isAutoUpdate: true,
          },
        },
      },
    ]);
  });

  it("lists only the organisation's own providers, never an instance-wide one with the same name", async () => {
    const { client, calls, http } = build();
    http.post.mockImplementationOnce(((url: string, body: unknown) => {
      calls.push({ method: 'post', url, body });
      return of({
        data: {
          result: [
            {
              id: 'instance-gh',
              name: 'GitHub',
              type: 'github',
              owner: 'IDP_OWNER_TYPE_SYSTEM',
            },
            {
              id: 'org-gh',
              name: 'GitHub',
              type: 'github',
              owner: 'IDP_OWNER_TYPE_ORG',
            },
          ],
        },
      });
    }) as never);

    const listed = await client.listIdentityProviders('pat', 'auth.example');

    expect(listed).toEqual([{ id: 'org-gh', name: 'GitHub', type: 'github' }]);
    expect(calls[0].body).toEqual({
      query: { limit: 100 },
      queries: [{ ownerTypeQuery: { ownerType: 'IDP_OWNER_TYPE_ORG' } }],
    });
  });

  it('takes a provider off the sign-in page, then deletes it', async () => {
    const { client, calls } = build();

    await client.removeIdentityProviderFromLogin(
      'pat',
      'auth.example',
      'idp-1',
    );
    await client.deleteIdentityProvider('pat', 'auth.example', 'idp-1');

    expect(
      calls.map((c) => `${c.method} ${c.url.replace(/^.*\/v1/, '')}`),
    ).toEqual(['delete /policies/login/idps/idp-1', 'delete /idps/idp-1']);
  });

  it('reads an absent metadata key as null, but lets an unreachable provider throw', async () => {
    const { client, http } = build();
    http.get.mockReturnValueOnce(
      throwError(() => ({ response: { status: 404 } })) as never,
    );
    await expect(
      client.findOrgMetadata('pat', 'auth.example', 'k'),
    ).resolves.toBeNull();

    http.get.mockReturnValueOnce(
      throwError(() => ({ response: { status: 503 } })) as never,
    );
    await expect(
      client.findOrgMetadata('pat', 'auth.example', 'k'),
    ).rejects.toEqual({ response: { status: 503 } });

    http.get.mockReturnValueOnce(
      of({
        data: {
          metadata: { value: Buffer.from('{"a":1}').toString('base64') },
        },
      }) as never,
    );
    await expect(
      client.findOrgMetadata('pat', 'auth.example', 'k'),
    ).resolves.toBe('{"a":1}');
  });
});
