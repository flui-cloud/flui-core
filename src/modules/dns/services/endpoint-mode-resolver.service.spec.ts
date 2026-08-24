// Pulled in transitively and ship ESM jest will not parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { EndpointModeResolverService } from './endpoint-mode-resolver.service';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';

const CLUSTER = {
  id: 'c1',
  name: 'control-cluster',
  masterIpAddress: '109.123.252.6',
} as never;

const ZONE = { dnsZone: { zoneName: 'dawit.blog' } } as never;
const TENANCY = 'guest-f0e5e994.control-cluster.dawit.blog';

const service = new EndpointModeResolverService();

/**
 * The path that decides what an application is called. Today every application
 * on the cluster draws from one flat pool of labels under `<cluster>.<zone>`;
 * a tenancy with a certificate of its own is named one label further in.
 */
describe('EndpointModeResolverService — the name a tenancy publishes under', () => {
  it('keeps the shared name when the tenancy has no subdomain', () => {
    expect(
      service.resolve({ cluster: CLUSTER, clusterDnsZone: ZONE, slug: 'memos' })
        .fqdn,
    ).toBe('memos.control-cluster.dawit.blog');
  });

  it('puts the application inside the tenancy when it has one', () => {
    expect(
      service.resolve({
        cluster: CLUSTER,
        clusterDnsZone: ZONE,
        slug: 'memos',
        tenancySubdomain: TENANCY,
      }).fqdn,
    ).toBe('memos.guest-f0e5e994.control-cluster.dawit.blog');
  });

  /**
   * Two guests both calling an application `memos` used to collide on one
   * label: whoever asked first got the name. Now they do not meet at all.
   */
  it('lets two tenancies use the same application name', () => {
    const one = service.resolve({
      cluster: CLUSTER,
      clusterDnsZone: ZONE,
      slug: 'memos',
      tenancySubdomain: 'guest-a.control-cluster.dawit.blog',
    }).fqdn;
    const two = service.resolve({
      cluster: CLUSTER,
      clusterDnsZone: ZONE,
      slug: 'memos',
      tenancySubdomain: 'guest-b.control-cluster.dawit.blog',
    }).fqdn;

    expect(one).not.toBe(two);
  });

  /**
   * The fallback that keeps a broken name from ever being written: a slug the
   * tenancy's wildcard could not cover falls back to the shared subdomain,
   * where the cluster's existing wildcard does answer.
   */
  it('falls back to the shared name when the slug would land outside the certificate', () => {
    expect(
      service.resolve({
        cluster: CLUSTER,
        clusterDnsZone: ZONE,
        slug: 'a.b',
        tenancySubdomain: TENANCY,
      }).fqdn,
    ).toBe('a.b.control-cluster.dawit.blog');
  });

  it('leaves a hostname the caller asked for alone', () => {
    expect(
      service.resolve({
        cluster: CLUSTER,
        clusterDnsZone: ZONE,
        slug: 'memos',
        tenancySubdomain: TENANCY,
        requestedFqdn: 'chosen.control-cluster.dawit.blog',
      }).fqdn,
    ).toBe('chosen.control-cluster.dawit.blog');
  });

  /** nip.io names carry an address, not a zone: there is nothing to nest under. */
  it('ignores the tenancy for an IP-mode hostname', () => {
    const resolved = service.resolve({
      cluster: CLUSTER,
      clusterDnsZone: null,
      requestedHostnameMode: HostnameMode.IP,
      slug: 'memos',
      tenancySubdomain: TENANCY,
    });

    expect(resolved.fqdn).toContain('109-123-252-6');
    expect(resolved.certChallenge).toBe(CertChallenge.HTTP_01);
  });
});
