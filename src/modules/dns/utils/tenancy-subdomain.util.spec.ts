import {
  DNS_LABEL_MAX,
  FQDN_MAX,
  buildTenancyFqdn,
  buildTenancySubdomain,
  isInsideTenancySubdomain,
  tenancyLabel,
  tenancyWildcardHost,
} from './tenancy-subdomain.util';

const NAMESPACE = 'user-guest-f0e5e994';
const CLUSTER = 'control-cluster';
const ZONE = 'dawit.blog';

const subdomain = () =>
  buildTenancySubdomain({
    namespace: NAMESPACE,
    clusterName: CLUSTER,
    zoneName: ZONE,
  });

describe('tenancyLabel', () => {
  it('drops the namespace prefix every derived namespace carries', () => {
    expect(tenancyLabel(NAMESPACE)).toBe('guest-f0e5e994');
  });

  it('leaves a namespace without that prefix alone', () => {
    expect(tenancyLabel('flui-sandbox-reference')).toBe(
      'flui-sandbox-reference',
    );
  });

  it('ignores case and a trailing dot', () => {
    expect(tenancyLabel('USER-Guest-A.')).toBe('guest-a');
  });

  it.each([
    ['nothing left after the prefix', 'user-'],
    ['a label that starts on a hyphen', 'user--guest'],
    ['a label that ends on a hyphen', 'user-guest-'],
    ['a character a hostname cannot carry', 'user-guest_1'],
    ['a dot, which would be two labels', 'user-guest.one'],
    ['a label past 63 octets', `user-${'a'.repeat(DNS_LABEL_MAX + 1)}`],
  ])('refuses %s', (_case, namespace) => {
    expect(tenancyLabel(namespace)).toBeNull();
  });

  it('accepts a label of exactly 63 octets', () => {
    const label = 'a'.repeat(DNS_LABEL_MAX);
    expect(tenancyLabel(`user-${label}`)).toBe(label);
  });
});

describe('buildTenancySubdomain', () => {
  it('is the tenancy label under the subdomain the cluster already serves', () => {
    expect(subdomain()).toBe('guest-f0e5e994.control-cluster.dawit.blog');
  });

  it.each([
    ['a namespace that is not a label', { namespace: 'user-' }],
    ['an empty cluster name', { clusterName: '' }],
    ['a cluster name with an illegal label', { clusterName: 'my_cluster' }],
    ['an empty zone', { zoneName: '' }],
    ['a zone with an illegal label', { zoneName: 'dawit_.blog' }],
  ])('refuses %s', (_case, over) => {
    expect(
      buildTenancySubdomain({
        namespace: NAMESPACE,
        clusterName: CLUSTER,
        zoneName: ZONE,
        ...over,
      }),
    ).toBeNull();
  });

  /**
   * A subdomain with no room for a label under it can be certified and never
   * used: the only names it covers are longer than a resolver accepts.
   */
  it('refuses a subdomain with no room left for an application under it', () => {
    const zone = `${'z'.repeat(DNS_LABEL_MAX)}.${'y'.repeat(DNS_LABEL_MAX)}.${'x'.repeat(DNS_LABEL_MAX)}.test`;
    const built = buildTenancySubdomain({
      namespace: NAMESPACE,
      clusterName: 'c'.repeat(DNS_LABEL_MAX),
      zoneName: zone,
    });
    expect(built).toBeNull();
  });
});

describe('tenancyWildcardHost', () => {
  /**
   * The single dnsName of the tenancy's Certificate. One star and one scope:
   * there is no `*.*.` shape in ACME or in any browser, which is exactly why a
   * tenancy needs a certificate of its own rather than a wider shared one.
   */
  it('is one star over the tenancy subdomain', () => {
    expect(tenancyWildcardHost(subdomain()!)).toBe(
      '*.guest-f0e5e994.control-cluster.dawit.blog',
    );
  });

  it('normalizes before starring it', () => {
    expect(tenancyWildcardHost('A.B.Test.')).toBe('*.a.b.test');
  });
});

describe('buildTenancyFqdn', () => {
  it('puts the application one label under the tenancy', () => {
    expect(buildTenancyFqdn('memos', subdomain()!)).toBe(
      'memos.guest-f0e5e994.control-cluster.dawit.blog',
    );
  });

  /**
   * The refusal that matters: a dotted slug lands two levels under the
   * tenancy, where `*.<tenancy>` does not reach. Producing the name anyway
   * would hand a guest a link whose certificate can never be valid.
   */
  it('refuses a slug that is not a single label', () => {
    expect(buildTenancyFqdn('a.b', subdomain()!)).toBeNull();
  });

  it.each([
    ['an empty slug', ''],
    ['a slug that starts on a hyphen', '-memos'],
    ['a slug with an underscore', 'my_app'],
    ['a wildcard as a slug', '*'],
  ])('refuses %s', (_case, slug) => {
    expect(buildTenancyFqdn(slug, subdomain()!)).toBeNull();
  });

  it('refuses a name past the length a resolver accepts', () => {
    const scope = `${'a'.repeat(DNS_LABEL_MAX)}.${'b'.repeat(DNS_LABEL_MAX)}.${'c'.repeat(DNS_LABEL_MAX)}.test`;
    const slug = 'd'.repeat(DNS_LABEL_MAX);
    expect(`${slug}.${scope}`.length).toBeGreaterThan(FQDN_MAX);
    expect(buildTenancyFqdn(slug, scope)).toBeNull();
  });
});

describe('isInsideTenancySubdomain', () => {
  const scope = 'guest-a.control-cluster.dawit.blog';

  it('accepts exactly one label under the tenancy', () => {
    expect(
      isInsideTenancySubdomain(
        'mine.guest-a.control-cluster.dawit.blog',
        scope,
      ),
    ).toBe(true);
  });

  it.each([
    ['another tenancy', 'mine.guest-b.control-cluster.dawit.blog'],
    ['the shared cluster subdomain', 'mine.control-cluster.dawit.blog'],
    [
      'two labels deep, past the certificate',
      'a.b.guest-a.control-cluster.dawit.blog',
    ],
    ['the subdomain itself', 'guest-a.control-cluster.dawit.blog'],
    [
      'a wildcard over its own subdomain',
      '*.guest-a.control-cluster.dawit.blog',
    ],
    ['a domain nobody here owns', 'proof.example.com'],
    [
      'a suffix that only looks like the scope',
      'mineguest-a.control-cluster.dawit.blog',
    ],
  ])('refuses %s', (_case, host) => {
    expect(isInsideTenancySubdomain(host, scope)).toBe(false);
  });

  it('ignores case and a trailing dot on both sides', () => {
    expect(
      isInsideTenancySubdomain(
        'Mine.Guest-A.Control-Cluster.Dawit.Blog.',
        'GUEST-A.control-cluster.dawit.blog.',
      ),
    ).toBe(true);
  });
});
