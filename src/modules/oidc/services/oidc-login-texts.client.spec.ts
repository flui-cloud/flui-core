import { of, throwError } from 'rxjs';
import { OidcLoginTextsClient } from './oidc-login-texts.client';

function build(fail: (url: string) => boolean = () => false) {
  const puts: Array<{ url: string; body: unknown }> = [];
  const http = {
    get: jest.fn((url: string) => {
      if (url.endsWith('/admin/v1/languages')) {
        return of({ data: { languages: ['en', 'it'] } });
      }
      if (url.includes('/text/default/login/it')) {
        return of({
          data: {
            customText: {
              isDefault: true,
              selectAccountText: { description: 'Usa il tuo account Zitadel' },
            },
          },
        });
      }
      if (url.includes('/text/default/message/init/it')) {
        return of({
          data: { customText: { isDefault: true, title: 'Zitadel - Init' } },
        });
      }
      return of({ data: { customText: { isDefault: true } } });
    }),
    put: jest.fn((url: string, body: unknown) => {
      if (fail(url)) return throwError(() => new Error('boom'));
      puts.push({ url, body });
      return of({ data: {} });
    }),
  };
  return { client: new OidcLoginTextsClient(http as never), http, puts };
}

describe('sign-in texts client', () => {
  it('writes only the groups that change, in every supported language', async () => {
    const { client, puts } = build();
    const result = await client.apply('pat', 'auth.example.com');
    expect(result.languages).toBe(2);
    expect(result.updated.sort()).toEqual(['init/it', 'login/it']);
    expect(puts).toHaveLength(2);
    expect(puts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: expect.stringMatching(/\/management\/v1\/text\/login\/it$/),
          body: {
            selectAccountText: { description: 'Usa il tuo account Flui' },
          },
        }),
        expect.objectContaining({
          url: expect.stringMatching(
            /\/management\/v1\/text\/message\/init\/it$/,
          ),
          body: { title: 'Flui - Init' },
        }),
      ]),
    );
  });

  it('fails as a whole when a group could not be written, so branding retries', async () => {
    const { client } = build((url) => url.includes('/text/login/it'));
    await expect(client.apply('pat', 'auth.example.com')).rejects.toThrow(
      /login\/it/,
    );
  });

  it('falls back to the management list of languages', async () => {
    const { client, http } = build();
    http.get.mockImplementationOnce(() =>
      throwError(() => new Error('forbidden')),
    );
    http.get.mockImplementationOnce(() => of({ data: { languages: ['de'] } }));
    const result = await client.apply('pat', 'auth.example.com');
    expect(result.languages).toBe(1);
    expect(http.get.mock.calls[1][0]).toMatch(/\/management\/v1\/languages$/);
  });
});
