import { publicApiBaseUrl } from './public-urls';

const reader =
  (env: Record<string, string>) =>
  (key: string): string | undefined =>
    env[key];

describe('publicApiBaseUrl', () => {
  it('prefers PUBLIC_API_URL over the other two', () => {
    expect(
      publicApiBaseUrl(
        reader({
          PUBLIC_API_URL: 'https://api.acme.dev/',
          API_BASE_URL: 'https://other.dev',
        }),
      ),
    ).toBe('https://api.acme.dev/api/v1');
  });

  it('falls back to API_BASE_URL', () => {
    expect(
      publicApiBaseUrl(reader({ API_BASE_URL: 'https://api.acme.dev' })),
    ).toBe('https://api.acme.dev/api/v1');
  });

  it('ends on localhost and the listening port when nothing is configured', () => {
    expect(publicApiBaseUrl(reader({ PORT: '4000' }))).toBe(
      'http://localhost:4000/api/v1',
    );
  });
});
