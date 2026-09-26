import {
  ACME_PUBLIC_NAMESERVERS,
  acmeResolverSentence,
  acmeResolverState,
} from './acme-resolvers.core';

describe('acmeResolverState', () => {
  const base = ['--v=2', '--cluster-resource-namespace=$(POD_NAMESPACE)'];

  it('adds the three flags to a cluster installed before them', () => {
    const s = acmeResolverState(base);
    expect(s.pinned).toBe(false);
    expect(s.nextArgs).toEqual([
      ...base,
      `--dns01-recursive-nameservers=${ACME_PUBLIC_NAMESERVERS}`,
      '--dns01-recursive-nameservers-only',
      `--acme-http01-solver-nameservers=${ACME_PUBLIC_NAMESERVERS}`,
    ]);
  });

  it('leaves a cluster alone once they are there, keeping its own servers', () => {
    const s = acmeResolverState([
      ...base,
      '--dns01-recursive-nameservers=9.9.9.9:53',
      '--dns01-recursive-nameservers-only',
      '--acme-http01-solver-nameservers=9.9.9.9:53',
    ]);
    expect(s).toEqual({
      pinned: true,
      nameservers: '9.9.9.9:53',
      nextArgs: null,
    });
  });

  it('adds only what is missing', () => {
    const s = acmeResolverState([
      ...base,
      '--dns01-recursive-nameservers=9.9.9.9:53',
    ]);
    expect(s.nextArgs?.slice(base.length + 1)).toEqual([
      '--dns01-recursive-nameservers-only',
      `--acme-http01-solver-nameservers=${ACME_PUBLIC_NAMESERVERS}`,
    ]);
  });

  it('says it in one sentence', () => {
    expect(
      acmeResolverSentence({ pinned: true, nameservers: '1.1.1.1:53' }),
    ).toBe('cert-manager checks names through public resolvers (1.1.1.1:53).');
    expect(acmeResolverSentence(null)).toContain('Could not read');
  });
});
