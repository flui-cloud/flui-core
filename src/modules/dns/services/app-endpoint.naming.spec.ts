// Pulled in transitively and ship ESM jest will not parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { AppEndpointService } from './app-endpoint.service';
import { EndpointModeResolverService } from './endpoint-mode-resolver.service';
import { ApplicationExposure } from '../../applications/enums/application-exposure.enum';
import { CreateAppEndpointDto } from '../dto/create-app-endpoint.dto';

/**
 * The seam where a hostname is decided, end to end: a guest's application takes
 * the installation's shared subdomain when there is one, and the cluster's own
 * subdomain when there is not.
 *
 * Written against the real `EndpointModeResolverService` rather than a stub —
 * the whole point of the test is which of the two names comes out, and a stub
 * would be the thing under test.
 */

const CLUSTER = {
  id: 'c-sandbox',
  name: 'control-cluster',
  masterIpAddress: '109.123.252.6',
};

const APPLICATION = {
  id: 'app-1',
  clusterId: 'c-sandbox',
  name: 'It Tools',
  slug: 'it-tools-125d30',
  k8sNamespace: 'user-guest-f0e5e994',
  port: 8080,
  exposure: ApplicationExposure.PUBLIC,
};

const ASSIGNMENT = {
  id: 'assignment-1',
  wildcardCertificate: true,
  dnsZone: { zoneName: 'dawit.blog' },
};

function build(subdomains: {
  shared?: string | null;
  tenancy?: string | null;
}) {
  const save = jest.fn(async (entity: Record<string, unknown>) => entity);

  const service = new AppEndpointService(
    {
      findOne: jest.fn(async () => null),
      create: (entity: Record<string, unknown>) => entity,
      save,
    } as never,
    { findOne: jest.fn(async () => CLUSTER) } as never,
    { findOne: jest.fn(async () => ASSIGNMENT) } as never,
    { findOne: jest.fn(async () => APPLICATION) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new EndpointModeResolverService(),
    {} as never,
    { assertClaimable: jest.fn() } as never,
    {
      activeSubdomain: jest.fn(async () => subdomains.tenancy ?? null),
    } as never,
    {
      activeSubdomain: jest.fn(async () => subdomains.shared ?? null),
    } as never,
  );

  return { service, save };
}

const dto = {
  applicationId: 'app-1',
  clusterDnsZoneId: 'assignment-1',
} as CreateAppEndpointDto;

describe('AppEndpointService.createEndpoint — where an application is published', () => {
  it('names a guest application under the installation-wide subdomain', async () => {
    const { service } = build({ shared: 'demo.dawit.blog' });

    const endpoint = await service.createEndpoint('c-sandbox', dto);

    expect(endpoint.fqdn).toBe('it-tools-125d30.demo.dawit.blog');
  });

  /**
   * One label under `demo`, exactly as applications sit one label under the
   * cluster name today. That is what the single wildcard — DNS and TLS alike —
   * reaches, and nothing deeper is ever produced.
   */
  it('puts it exactly one label under the shared subdomain', async () => {
    const { service } = build({ shared: 'demo.dawit.blog' });

    const endpoint = await service.createEndpoint('c-sandbox', dto);

    expect(
      endpoint.fqdn.slice(0, -'.demo.dawit.blog'.length).includes('.'),
    ).toBe(false);
  });

  /**
   * The default, and the behaviour of every installation that configures
   * nothing: unchanged, line for line.
   */
  it('falls back to the cluster subdomain when there is no shared one', async () => {
    const { service } = build({ shared: null });

    const endpoint = await service.createEndpoint('c-sandbox', dto);

    expect(endpoint.fqdn).toBe('it-tools-125d30.control-cluster.dawit.blog');
  });

  /**
   * `FLUI_SANDBOX_TENANCY_SUBDOMAIN` is off by decision, not by accident — but
   * while the code is still there it must still be reachable, or the flag would
   * be a lie rather than a switch.
   */
  it('still honours the per-tenancy name when only that one is on', async () => {
    const { service } = build({
      shared: null,
      tenancy: 'guest-f0e5e994.control-cluster.dawit.blog',
    });

    const endpoint = await service.createEndpoint('c-sandbox', dto);

    expect(endpoint.fqdn).toBe(
      'it-tools-125d30.guest-f0e5e994.control-cluster.dawit.blog',
    );
  });

  /** Both configured is not a shape anyone should run, but it must be decided. */
  it('prefers the shared subdomain when both are available', async () => {
    const { service } = build({
      shared: 'demo.dawit.blog',
      tenancy: 'guest-f0e5e994.control-cluster.dawit.blog',
    });

    const endpoint = await service.createEndpoint('c-sandbox', dto);

    expect(endpoint.fqdn).toBe('it-tools-125d30.demo.dawit.blog');
  });
});

/**
 * A message is a finding, not a fact about the row: the reconcile that made it
 * must be able to take it back. Live, an endpoint read `valid`, `IN_SYNC`, with
 * a wildcard bound — and still carried "has no ready wildcard ClusterIssuer.
 * Configure the DNS-01 issuer", telling the operator to set up what was already
 * set up.
 */
describe('AppEndpointService.markReconciliationComplete, the certificate message', () => {
  function make(existing: string | null) {
    const endpoint: Record<string, unknown> = {
      id: 'ep-1',
      certificateMessage: existing,
    };
    const service = Object.create(
      AppEndpointService.prototype,
    ) as AppEndpointService;
    const r = service as unknown as Record<string, unknown>;
    r.getEndpoint = jest.fn(async () => endpoint);
    r.endpointRepository = { save: jest.fn(async (e: unknown) => e) };
    return { service, endpoint };
  }

  const complete = (
    service: AppEndpointService,
    message: string | null | undefined,
  ) =>
    (
      service as unknown as {
        markReconciliationComplete(
          id: string,
          a?: string,
          b?: string,
          c?: unknown,
          d?: string | null,
        ): Promise<unknown>;
      }
    ).markReconciliationComplete(
      'ep-1',
      undefined,
      undefined,
      undefined,
      message,
    );

  it('withdraws a finding the run no longer makes', async () => {
    const h = make('has no ready wildcard ClusterIssuer');

    await complete(h.service, null);

    expect(h.endpoint.certificateMessage).toBeNull();
  });

  it('keeps one the run does make', async () => {
    const h = make(null);

    await complete(h.service, 'DNS-01 solver missing');

    expect(h.endpoint.certificateMessage).toBe('DNS-01 solver missing');
  });

  it('leaves it alone when the caller says nothing about it', async () => {
    const h = make('something earlier');

    await complete(h.service, undefined);

    expect(h.endpoint.certificateMessage).toBe('something earlier');
  });
});
