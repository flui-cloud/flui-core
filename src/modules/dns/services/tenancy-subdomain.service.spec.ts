// Pulled in transitively and ship ESM jest will not parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { TenancySubdomainService } from './tenancy-subdomain.service';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';

const CLUSTER = { id: 'c1', name: 'control-cluster' } as never;
const NAMESPACE = 'user-guest-f0e5e994';
const SUBDOMAIN = 'guest-f0e5e994.control-cluster.dawit.blog';

interface Options {
  enabled?: boolean;
  isTenancy?: boolean;
  zones?: string[];
  certificate?: { status: CertificateStatus } | null;
  ensure?: { ready: boolean } | null;
  ensureThrows?: boolean;
  deletes?: boolean;
}

function build(opts: Options = {}) {
  const zones = (opts.zones ?? ['dawit.blog']).map((zoneName) => ({
    dnsZone: { zoneName },
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
  const deleteForScope = jest.fn(
    async (_clusterId: string, _scope: string) => opts.deletes ?? true,
  );
  const getByScope = jest.fn(async () =>
    opts.certificate === undefined
      ? { status: CertificateStatus.VALID }
      : opts.certificate,
  );

  const service = new TenancySubdomainService(
    {
      get: () => (opts.enabled === false ? 'false' : 'true'),
    } as never,
    { exists: jest.fn(async () => opts.isTenancy !== false) } as never,
    { find: jest.fn(async () => zones) } as never,
    { ensureForScope, getByScope, deleteForScope } as never,
  );

  return { service, ensureForScope, deleteForScope, getByScope };
}

describe('TenancySubdomainService — the flag', () => {
  it('is off unless the environment says true', () => {
    const off = new TenancySubdomainService(
      { get: () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(off.isEnabled()).toBe(false);

    const nonsense = new TenancySubdomainService(
      { get: () => 'yes' } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(nonsense.isEnabled()).toBe(false);
  });
});

describe('TenancySubdomainService.nominalSubdomain', () => {
  it('names the tenancy under the subdomain the cluster serves', async () => {
    const { service } = build();
    await expect(
      service.nominalSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBe(SUBDOMAIN);
  });

  it('is null when the feature is off', async () => {
    const { service } = build({ enabled: false });
    await expect(
      service.nominalSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBeNull();
  });

  it('is null for a namespace that is not a sandbox tenancy', async () => {
    const { service } = build({ isTenancy: false });
    await expect(
      service.nominalSubdomain(CLUSTER, 'user-dawit', 'dawit.blog'),
    ).resolves.toBeNull();
  });
});

/**
 * The rule the design rests on: a tenancy is named after itself only once the
 * certificate covering that name is valid. Anything else hands a visitor a link
 * their browser refuses.
 */
describe('TenancySubdomainService.activeSubdomain', () => {
  it('is the tenancy name once its certificate is valid', async () => {
    const { service } = build();
    await expect(
      service.activeSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBe(SUBDOMAIN);
  });

  it.each([
    ['no certificate was ever asked for', null],
    ['the certificate is still issuing', { status: CertificateStatus.ISSUING }],
    ['the certificate failed', { status: CertificateStatus.FAILED }],
    ['the certificate is only pending', { status: CertificateStatus.PENDING }],
  ])('keeps the shared name while %s', async (_case, certificate) => {
    const { service } = build({ certificate: certificate as never });
    await expect(
      service.activeSubdomain(CLUSTER, NAMESPACE, 'dawit.blog'),
    ).resolves.toBeNull();
  });
});

describe('TenancySubdomainService.activeSubdomains', () => {
  it('lists one name per zone whose certificate is valid', async () => {
    const { service } = build({ zones: ['dawit.blog', 'example.test'] });
    await expect(service.activeSubdomains(CLUSTER, NAMESPACE)).resolves.toEqual(
      [SUBDOMAIN, 'guest-f0e5e994.control-cluster.example.test'],
    );
  });

  it('is empty while no certificate is valid, so the caller keeps today’s rule', async () => {
    const { service } = build({ certificate: null });
    await expect(service.activeSubdomains(CLUSTER, NAMESPACE)).resolves.toEqual(
      [],
    );
  });

  it('is empty when the feature is off', async () => {
    const { service } = build({ enabled: false });
    await expect(service.activeSubdomains(CLUSTER, NAMESPACE)).resolves.toEqual(
      [],
    );
  });
});

describe('TenancySubdomainService.ensureCertificate', () => {
  it('asks the existing wildcard machine for the tenancy scope', async () => {
    const { service, ensureForScope } = build();

    await expect(
      service.ensureCertificate(CLUSTER, NAMESPACE),
    ).resolves.toEqual({ subdomain: SUBDOMAIN, ready: true });
    expect(ensureForScope).toHaveBeenCalledWith('c1', SUBDOMAIN, NAMESPACE);
  });

  it('picks the same zone every time when the cluster serves several', async () => {
    const { service, ensureForScope } = build({
      zones: ['zeta.test', 'alpha.test'],
    });

    await service.ensureCertificate(CLUSTER, NAMESPACE);

    expect(ensureForScope).toHaveBeenCalledWith(
      'c1',
      'guest-f0e5e994.control-cluster.alpha.test',
      NAMESPACE,
    );
  });

  it('reports an order still running rather than pretending it landed', async () => {
    const { service } = build({ ensure: { ready: false } });

    await expect(
      service.ensureCertificate(CLUSTER, NAMESPACE),
    ).resolves.toEqual({ subdomain: SUBDOMAIN, ready: false });
  });

  /**
   * Provisioning must survive a certificate authority having a bad day: the
   * tenancy simply keeps the name every tenancy has today.
   */
  it('swallows a refusal from the issuer', async () => {
    const { service } = build({ ensureThrows: true });

    await expect(
      service.ensureCertificate(CLUSTER, NAMESPACE),
    ).resolves.toBeNull();
  });

  it('does nothing when the cluster serves no zone', async () => {
    const { service, ensureForScope } = build({ zones: [] });

    await expect(
      service.ensureCertificate(CLUSTER, NAMESPACE),
    ).resolves.toBeNull();
    expect(ensureForScope).not.toHaveBeenCalled();
  });

  it('does nothing when the feature is off', async () => {
    const { service, ensureForScope } = build({ enabled: false });

    await expect(
      service.ensureCertificate(CLUSTER, NAMESPACE),
    ).resolves.toBeNull();
    expect(ensureForScope).not.toHaveBeenCalled();
  });
});

describe('TenancySubdomainService.releaseCertificates', () => {
  /**
   * The master Secret lives in `flui-system`: deleting the tenancy's namespace
   * leaves the certificate behind, renewing every sixty days for a name nothing
   * serves.
   */
  it('removes the tenancy certificate in every zone', async () => {
    const { service, deleteForScope } = build({
      zones: ['dawit.blog', 'example.test'],
    });

    await expect(service.releaseCertificates(CLUSTER, NAMESPACE)).resolves.toBe(
      2,
    );
    expect(deleteForScope.mock.calls.map((c) => c[1])).toEqual([
      SUBDOMAIN,
      'guest-f0e5e994.control-cluster.example.test',
    ]);
  });

  it('counts nothing when there was nothing to remove', async () => {
    const { service } = build({ deletes: false });

    await expect(service.releaseCertificates(CLUSTER, NAMESPACE)).resolves.toBe(
      0,
    );
  });

  /**
   * Runs from the reaper, which records failures instead of throwing them: one
   * unreachable cluster must not stop the rest of the teardown.
   */
  it('survives a delete that throws', async () => {
    const { service, deleteForScope } = build();
    deleteForScope.mockRejectedValueOnce(new Error('apiserver down'));

    await expect(service.releaseCertificates(CLUSTER, NAMESPACE)).resolves.toBe(
      0,
    );
  });

  /**
   * Cleanup is not gated on the flag. Turning the feature off must not strand
   * the certificates it issued while it was on.
   */
  it('still cleans up when the feature has since been turned off', async () => {
    const { service, deleteForScope } = build({ enabled: false });

    await expect(service.releaseCertificates(CLUSTER, NAMESPACE)).resolves.toBe(
      1,
    );
    expect(deleteForScope).toHaveBeenCalled();
  });
});
