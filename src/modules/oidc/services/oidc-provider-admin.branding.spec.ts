jest.mock('@kubernetes/client-node', () => ({}));

import { of, throwError } from 'rxjs';
import {
  BRANDING_ASSET_PATHS,
  OidcProviderAdminClient,
} from './oidc-provider-admin.service';

describe('branding on the identity provider', () => {
  it('uploads to the organisation label policy asset routes of Zitadel v4.15', () => {
    expect(BRANDING_ASSET_PATHS).toEqual({
      'logo-light': '/assets/v1/org/policy/label/logo',
      'logo-dark': '/assets/v1/org/policy/label/logo/dark',
      'icon-light': '/assets/v1/org/policy/label/icon',
      'icon-dark': '/assets/v1/org/policy/label/icon/dark',
    });
  });

  it('posts the file as the multipart `file` field with the provider Host', async () => {
    const http = { post: jest.fn(() => of({ data: {} })) };
    const client = new OidcProviderAdminClient(http as never);
    await client.uploadBrandingAsset(
      'pat',
      'auth.example.com',
      'icon-dark',
      Buffer.from('png'),
      'icon-dark.png',
      'image/png',
    );
    const [url, form, options] = http.post.mock.calls[0] as unknown as [
      string,
      FormData,
      { headers: Record<string, string> },
    ];
    expect(url).toMatch(/\/assets\/v1\/org\/policy\/label\/icon\/dark$/);
    expect(form.get('file')).toBeTruthy();
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer pat',
      Host: 'auth.example.com',
    });
  });

  it('creates the custom policy with dark colours, watermark and suffix settings, and tolerates an unchanged one', async () => {
    const http = {
      get: jest.fn(() => of({ data: { policy: { isDefault: false } } })),
      put: jest.fn(() =>
        throwError(() => ({
          response: {
            status: 400,
            data: {
              code: 9,
              message: 'Private Label Policy has not been changed (Org-8nfSr)',
            },
          },
        })),
      ),
      post: jest.fn(),
    };
    const client = new OidcProviderAdminClient(http as never);
    await expect(
      client.upsertCustomLabelPolicy('pat', 'auth.example.com', {
        primaryColor: '#225AF1',
        warnColorDark: '#F04242',
        fontColorDark: '#E5E9F0',
        hideLoginNameSuffix: true,
        disableWatermark: true,
      }),
    ).resolves.toBeUndefined();
    expect((http.put.mock.calls[0] as unknown[])[1]).toMatchObject({
      warnColorDark: '#F04242',
      fontColorDark: '#E5E9F0',
      hideLoginNameSuffix: true,
      disableWatermark: true,
    });
  });

  it('lets any other policy failure through', async () => {
    const http = {
      get: jest.fn(() => of({ data: { policy: { isDefault: true } } })),
      post: jest.fn(() =>
        throwError(() => ({
          response: { status: 403, data: { message: 'denied' } },
        })),
      ),
    };
    const client = new OidcProviderAdminClient(http as never);
    await expect(
      client.upsertCustomLabelPolicy('pat', 'auth.example.com', {}),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
});
