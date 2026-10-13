jest.mock('@kubernetes/client-node', () => ({}));

import { Observable, of, throwError } from 'rxjs';
import { OidcProviderAdminClient } from './oidc-provider-admin.service';

describe('organisation metadata on the identity provider', () => {
  const ORG_METADATA = /\/management\/v1\/metadata\/flui\.sign-in\.github$/;

  const build = (getAnswer: () => Observable<unknown>) => {
    const http = {
      get: jest.fn(getAnswer),
      post: jest.fn(() => of({ data: {} })),
    };
    return { client: new OidcProviderAdminClient(http as never), http };
  };

  it('writes the value base64-encoded on the organisation metadata route', async () => {
    const { client, http } = build(() => of({ data: {} }));

    await client.setOrgMetadata(
      'pat',
      'auth.example',
      'flui.sign-in.github',
      '{"a":1}',
    );

    expect(http.post).toHaveBeenCalledWith(
      expect.stringMatching(ORG_METADATA),
      { value: Buffer.from('{"a":1}').toString('base64') },
      expect.anything(),
    );
  });

  it('reads and decodes a value from the same route', async () => {
    const value = Buffer.from('{"a":1}').toString('base64');
    const { client, http } = build(() => of({ data: { metadata: { value } } }));

    await expect(
      client.findOrgMetadata('pat', 'auth.example', 'flui.sign-in.github'),
    ).resolves.toBe('{"a":1}');
    await expect(
      client.getOrgMetadata('pat', 'auth.example', 'flui.sign-in.github'),
    ).resolves.toBe('{"a":1}');
    for (const [url] of http.get.mock.calls as unknown as Array<[string]>) {
      expect(url).toMatch(ORG_METADATA);
    }
  });

  it('reads an absent key as null and lets any other failure through', async () => {
    const absent = build(() =>
      throwError(() => ({ response: { status: 404 } })),
    );
    await expect(
      absent.client.findOrgMetadata(
        'pat',
        'auth.example',
        'flui.sign-in.github',
      ),
    ).resolves.toBeNull();

    const down = build(() => throwError(() => ({ response: { status: 503 } })));
    await expect(
      down.client.findOrgMetadata('pat', 'auth.example', 'flui.sign-in.github'),
    ).rejects.toEqual({ response: { status: 503 } });
  });
});
