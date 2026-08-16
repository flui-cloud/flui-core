// The processor's import graph reaches ESM-only packages ts-jest cannot
// transform; the suite calls one pure method and constructs nothing.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { CatalogInstallProcessor } from './catalog-install.processor';

/**
 * Found live: `resourceOverrides` was applied when installing a standalone
 * catalogue app and silently dropped when installing a composed one. The field
 * was still accepted by the API and still counted in the capacity preview, so a
 * user shrinking a composed install to fit a small cluster got the manifest's
 * own numbers and a pod their namespace would not admit.
 */
describe('catalog install resource overrides', () => {
  const apply = (
    base: unknown,
    overrides: unknown,
  ): {
    cpu?: { request?: string; limit?: string };
    memory?: { request?: string; limit?: string };
  } =>
    (
      CatalogInstallProcessor.prototype as unknown as {
        applyResourceOverrides: (b: unknown, o: unknown) => never;
      }
    ).applyResourceOverrides.call(null, base, overrides);

  const manifestDefaults = {
    cpu: { request: '250m', limit: '2' },
    memory: { request: '256Mi', limit: '2Gi' },
  };

  it('caps what the manifest asked for', () => {
    const out = apply(manifestDefaults, {
      cpu: { limit: '1' },
      memory: { limit: '1Gi' },
    });
    expect(out.cpu?.limit).toBe('1');
    expect(out.memory?.limit).toBe('1Gi');
  });

  it('leaves the requests alone when only the ceiling is overridden', () => {
    const out = apply(manifestDefaults, { cpu: { limit: '1' } });
    expect(out.cpu?.request).toBe('250m');
    expect(out.memory?.limit).toBe('2Gi');
  });

  it('returns the manifest untouched when nothing is overridden', () => {
    expect(apply(manifestDefaults, undefined)).toEqual(manifestDefaults);
  });
});
