jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { readsComponentSecret } from './catalog-install.processor';

describe('a value read from a sibling component', () => {
  const secrets = new Map([['db', new Set(['MARIADB_PASSWORD'])]]);

  it('is a secret when it carries the sibling secret', () => {
    expect(
      readsComponentSecret('{{components.db.env.MARIADB_PASSWORD}}', secrets),
    ).toBe(true);
    expect(
      readsComponentSecret(
        'mysql://wp:{{ components.db.env.MARIADB_PASSWORD }}@db:3306/wp',
        secrets,
      ),
    ).toBe(true);
  });

  it('stays plain when it carries only plain values', () => {
    expect(
      readsComponentSecret('{{components.db.env.MARIADB_USER}}', secrets),
    ).toBe(false);
    expect(readsComponentSecret('{{components.db.host}}:3306', secrets)).toBe(
      false,
    );
    expect(
      readsComponentSecret(
        '{{components.cache.env.MARIADB_PASSWORD}}',
        secrets,
      ),
    ).toBe(false);
  });
});
