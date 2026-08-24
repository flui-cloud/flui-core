// Pulled in transitively and ship ESM jest will not parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { SandboxSubdomainService } from './sandbox-subdomain.service';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';

const CLUSTER = {
  id: 'c-sandbox',
  name: 'control-cluster',
  masterIpAddress: '109.123.252.6',
} as never;
const OTHER_CLUSTER = {
  id: 'c-other',
  name: 'workload-cluster',
  masterIpAddress: '203.0.113.4',
} as never;
const NAMESPACE = 'user-guest-f0e5e994';

interface Options {
  enabled?: boolean;
  label?: string;
  sandboxClusterId?: string | null;
  isTenancy?: boolean;
  zones?: string[];
  certificate?: { status: CertificateStatus } | null;
  ensure?: { ready: boolean } | null;
  ensureThrows?: boolean;
}

function build(opts: Options = {}) {
  const label = opts.label ?? 'demo';
  const sandboxClusterId =
    opts.sandboxClusterId === undefined ? 'c-sandbox' : opts.sandboxClusterId;
  const enabled = opts.enabled !== false;

  const config = {
    isEnabled: () => enabled,
    label: () => label,
    sandboxClusterId: () => sandboxClusterId,
    ownsCluster: (clusterId: string) =>
      enabled && !!sandboxClusterId && sandboxClusterId === clusterId,
  };

  const assignments = (opts.zones ?? ['dawit.blog']).map((zoneName) => ({
    dnsZone: { zoneName, recordTtlSeconds: 300, providerZoneId: 'pz-1' },
  }));

  const ensureForScope = jest.fn(async () => {
    if (opts.ensureThrows) throw new Error('acme refused');
    return opts.ensure === undefined
      ? { wildcardCertificateId: 'wc-1', tlsSecretName: 's', ready: true }
      : opts.ensure && {
          wildcardCertificateId: 'wc-1',
          tlsSecretName: 's',
          ready: opts.ensure.ready,
        };
  });
  const getByScope = jest.fn(async () =>
    opts.certificate === undefined
      ? { status: CertificateStatus.VALID }
      : opts.certificate,
  );
  const ensureWildcardRecord = jest.fn(async () => 'published');

  const service = new SandboxSubdomainService(
    config as never,
    { exists: jest.fn(async () => opts.isTenancy !== false) } as never,
    { find: jest.fn(async () => assignments) } as never,
    { ensureForScope, getByScope } as never,
    { ensureWildcardRecord } as never,
  );

  return { service, ensureForScope, getByScope, ensureWildcardRecord };
}

describe('SandboxSubdomainService — the name a guest application takes', () => {
  it('is the installation-wide subdomain, not one per tenancy', async () => {
    const { service } = build();

    await expect(
      service.nominalSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBe('demo.dawit.blog');
  });

  it('honours the label the installation chose', async () => {
    const { service } = build({ label: 'try' });

    await expect(
      service.nominalSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBe('try.dawit.blog');
  });

  /**
   * Two guests, one name: that is the whole point. Per-tenancy names would make
   * the certificate count grow with the number of visitors, which is the
   * ceiling this shape exists to stay under.
   */
  it('is the same name for every tenancy on the installation', async () => {
    const { service } = build();

    const first = await service.nominalSubdomain(
      CLUSTER,
      'user-guest-aaaa',
      'dawit.blog',
    );
    const second = await service.nominalSubdomain(
      CLUSTER,
      'user-guest-bbbb',
      'dawit.blog',
    );

    expect(first).toBe(second);
  });

  it('is nothing at all when the installation never configured one', async () => {
    const { service } = build({ enabled: false });

    await expect(
      service.nominalSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBeNull();
    await expect(service.activeSubdomains(CLUSTER, NAMESPACE)).resolves.toEqual(
      [],
    );
  });

  /** The instance's own applications keep `<slug>.<cluster>.<zone>`. */
  it('is nothing for a namespace that is not a sandbox tenancy', async () => {
    const { service } = build({ isTenancy: false });

    await expect(
      service.nominalSubdomain(CLUSTER, 'user-dawit', 'dawit.blog'),
    ).resolves.toBeNull();
  });

  it('is nothing on a cluster the shared subdomain does not belong to', async () => {
    const { service } = build();

    await expect(
      service.nominalSubdomain(OTHER_CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBeNull();
  });

  it('is nothing when the label is not a hostname label', async () => {
    const { service } = build({ label: 'not a label' });

    await expect(
      service.nominalSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBeNull();
  });
});

/**
 * The rule the whole shape turns on: the new name is used only once the
 * certificate that covers it is valid. Before then the tenancy keeps the
 * cluster name, which already works — a hostname is written once, so moving it
 * early means a link the browser refuses for as long as the order takes.
 */
describe('SandboxSubdomainService.activeSubdomain', () => {
  it('gives the shared name once the certificate is valid', async () => {
    const { service } = build({
      certificate: { status: CertificateStatus.VALID },
    });

    await expect(
      service.activeSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBe('demo.dawit.blog');
  });

  it('withholds it while the certificate is still being issued', async () => {
    const { service } = build({
      certificate: { status: CertificateStatus.ISSUING },
    });

    await expect(
      service.activeSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBeNull();
  });

  it('withholds it when no certificate was ever asked for', async () => {
    const { service } = build({ certificate: null });

    await expect(
      service.activeSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBeNull();
  });
});

describe('SandboxSubdomainService.ensure', () => {
  it('publishes one wildcard record and orders one wildcard certificate', async () => {
    const { service, ensureForScope, ensureWildcardRecord } = build({
      certificate: null,
    });

    await expect(service.ensure(CLUSTER, NAMESPACE)).resolves.toEqual({
      subdomain: 'demo.dawit.blog',
      ready: true,
    });

    expect(ensureWildcardRecord).toHaveBeenCalledWith(
      expect.objectContaining({ zoneName: 'dawit.blog' }),
      {
        name: '*.demo',
        type: DnsRecordType.A,
        value: '109.123.252.6',
        ttl: 300,
      },
    );
    expect(ensureForScope).toHaveBeenCalledWith(
      'c-sandbox',
      'demo.dawit.blog',
      NAMESPACE,
    );
  });

  /**
   * The measurement the decision rests on: issuance is a constant of the
   * installation, not a function of how many guests pass through it. The
   * hundredth tenancy must not reach ACME at all.
   */
  it('never orders a second certificate once the first one is valid', async () => {
    const { service, ensureForScope } = build({
      certificate: { status: CertificateStatus.VALID },
    });

    for (let i = 0; i < 100; i++) {
      await service.ensure(CLUSTER, `user-guest-${i}`);
    }

    expect(ensureForScope).not.toHaveBeenCalled();
  });

  it('does nothing at all when the installation never configured one', async () => {
    const { service, ensureForScope, ensureWildcardRecord } = build({
      enabled: false,
    });

    await expect(service.ensure(CLUSTER, NAMESPACE)).resolves.toBeNull();
    expect(ensureForScope).not.toHaveBeenCalled();
    expect(ensureWildcardRecord).not.toHaveBeenCalled();
  });

  it('does nothing on a cluster the shared subdomain does not belong to', async () => {
    const { service, ensureForScope } = build();

    await expect(service.ensure(OTHER_CLUSTER, NAMESPACE)).resolves.toBeNull();
    expect(ensureForScope).not.toHaveBeenCalled();
  });

  /**
   * A tenancy without the shared certificate is a tenancy on the cluster name,
   * which is where every tenancy is today. A tenancy that failed to provision
   * because ACME was slow is a tenancy nobody gets.
   */
  it('never throws when the certificate cannot be issued', async () => {
    const { service } = build({ certificate: null, ensureThrows: true });

    await expect(service.ensure(CLUSTER, NAMESPACE)).resolves.toBeNull();
  });

  /**
   * Deterministic across restarts and API instances: picking whichever zone the
   * database returned first would order a second certificate on a retry and
   * leave the installation using neither name.
   */
  it('always picks the same zone when the cluster serves several', async () => {
    const { service, ensureForScope } = build({
      zones: ['zzz.example', 'aaa.example'],
      certificate: null,
    });

    await service.ensure(CLUSTER, NAMESPACE);

    expect(ensureForScope).toHaveBeenCalledWith(
      'c-sandbox',
      'demo.aaa.example',
      NAMESPACE,
    );
  });
});
