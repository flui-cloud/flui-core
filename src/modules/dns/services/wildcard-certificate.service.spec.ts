// Pulled in transitively and ship ESM jest will not parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { WildcardCertificateService } from './wildcard-certificate.service';
import { AcmeCertificateService } from '../../providers/services/acme-certificate.service';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { tenancyWildcardHost } from '../utils/tenancy-subdomain.util';

const ZONE = 'dawit.blog';
const CLUSTER_SCOPE = `control-cluster.${ZONE}`;
const TENANCY_SCOPE = `guest-f0e5e994.${CLUSTER_SCOPE}`;

interface Options {
  secretReady?: boolean;
  issuer?: {
    issuerName: string;
    certificateProvider: CertificateProvider;
  } | null;
  zone?: unknown;
}

function build(opts: Options = {}) {
  const applied: string[] = [];
  const saved: Record<string, unknown>[] = [];

  const repository = {
    findOne: jest.fn().mockResolvedValue(null),
    create: (row: Record<string, unknown>) => ({ ...row, id: 'wc-1' }),
    save: jest.fn(async (row: Record<string, unknown>) => {
      saved.push(row);
      return { ...row, id: row.id ?? 'wc-1' };
    }),
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn(),
  };

  const zone =
    opts.zone === undefined
      ? {
          id: 'assign-1',
          dnsZoneId: 'z-1',
          dnsZone: {
            zoneName: ZONE,
            dnsProvider: 'hetzner',
            providerZoneId: 'pz-1',
          },
        }
      : opts.zone;

  const clusterDnsZoneService = {
    getZoneForFqdn: jest.fn().mockResolvedValue(zone),
    resolveWildcardIssuer: jest.fn().mockResolvedValue(
      opts.issuer === undefined
        ? {
            issuerName: 'letsencrypt-production-wildcard',
            certificateProvider: CertificateProvider.LETS_ENCRYPT,
          }
        : opts.issuer,
    ),
  };

  const kubernetesService = {
    applyManifest: jest.fn(async (_kc: string, manifest: string) => {
      applied.push(manifest);
    }),
    // Ready by default; an unready master is what a brand new tenancy has.
    waitForSecret: jest.fn(async () => {
      if (opts.secretReady === false) throw new Error('timed out');
      return true;
    }),
    getResource: jest.fn(async () =>
      opts.secretReady === false
        ? null
        : { data: { 'tls.crt': 'Y3J0', 'tls.key': 'a2V5' } },
    ),
    deleteResource: jest.fn(),
    patchKubeconfigServer: jest.fn().mockReturnValue('kubeconfig'),
  };

  const service = new WildcardCertificateService(
    repository as never,
    {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'c1', kubeconfigEncrypted: 'enc' }),
    } as never,
    clusterDnsZoneService as never,
    // The real one: the manifest it renders is the artefact under test.
    new AcmeCertificateService(),
    kubernetesService as never,
    { decrypt: jest.fn().mockReturnValue('kubeconfig') } as never,
    { isEnabled: () => true, getMasterNamespace: () => 'flui-system' } as never,
    { ensureInstalled: jest.fn() } as never,
    {
      getDnsProviderOrFail: () => ({
        listRecords: jest.fn().mockResolvedValue([]),
        deleteRecord: jest.fn(),
      }),
    } as never,
  );

  return { service, applied, saved, repository, kubernetesService };
}

/**
 * The function that decides how deep a wildcard may go. It had no test: the
 * whole question of whether a tenancy can have a subdomain of its own rests on
 * whether this returns a multi-label scope or refuses one.
 */
describe('WildcardCertificateService.resolveScope', () => {
  const { service } = build();

  it.each([
    ['an application on the zone apex', `memos.${ZONE}`, ZONE],
    [
      "an application in the cluster's subdomain",
      `memos.${CLUSTER_SCOPE}`,
      CLUSTER_SCOPE,
    ],
    [
      "an application in a tenancy's subdomain",
      `memos.${TENANCY_SCOPE}`,
      TENANCY_SCOPE,
    ],
  ])('resolves %s', (_case, fqdn, expected) => {
    expect(service.resolveScope(fqdn, ZONE)).toBe(expected);
  });

  it.each([
    ['the apex itself', ZONE],
    ['a name outside the zone', 'proof.example.com'],
  ])('refuses %s', (_case, fqdn) => {
    expect(service.resolveScope(fqdn, ZONE)).toBeNull();
  });

  it('ignores case', () => {
    expect(
      service.resolveScope(`Memos.${TENANCY_SCOPE.toUpperCase()}`, ZONE),
    ).toBe(TENANCY_SCOPE);
  });
});

describe('WildcardCertificateService.ensureForScope', () => {
  const certificateOf = (applied: string[]) =>
    applied.find((m) => m.includes('kind: Certificate')) ?? '';

  it('asks for one dnsName, the star over the tenancy and nothing wider', async () => {
    const { service, applied } = build();

    await service.ensureForScope('c1', TENANCY_SCOPE, 'user-guest-f0e5e994');

    const manifest = certificateOf(applied);
    expect(manifest).toContain(`- "${tenancyWildcardHost(TENANCY_SCOPE)}"`);
    // One dnsName exactly: `*.*.` is not a shape ACME or a browser accepts, so
    // a deeper tenancy can never be folded into the cluster's own certificate.
    expect(
      manifest.split('\n').filter((line) => line.trim().startsWith('- "')),
    ).toHaveLength(1);
    expect(manifest).toContain('kind: ClusterIssuer');
    expect(manifest).toContain('name: letsencrypt-production-wildcard');
  });

  it('names the Certificate and its Secret after the full scope, so two tenancies never collide', async () => {
    const { service, applied } = build();

    await service.ensureForScope('c1', TENANCY_SCOPE, 'user-guest-f0e5e994');

    const manifest = certificateOf(applied);
    expect(manifest).toContain(
      'name: wildcard-guest-f0e5e994-control-cluster-dawit-blog',
    );
    expect(manifest).toContain(
      'secretName: wildcard-guest-f0e5e994-control-cluster-dawit-blog-tls',
    );
  });

  it('reports VALID once the master Secret exists', async () => {
    const { service, saved } = build();

    const result = await service.ensureForScope(
      'c1',
      TENANCY_SCOPE,
      'user-guest-f0e5e994',
    );

    expect(result?.ready).toBe(true);
    expect(saved.at(-1)?.status).toBe(CertificateStatus.VALID);
  });

  /**
   * The state every new tenancy is in for the first minutes. It must be
   * reported, not thrown: the caller decides what to do with a name that has no
   * certificate yet, and throwing would take the whole provisioning down with it.
   */
  it('reports ISSUING, without throwing, while the certificate is not there yet', async () => {
    const { service, saved } = build({ secretReady: false });

    const result = await service.ensureForScope(
      'c1',
      TENANCY_SCOPE,
      'user-guest-f0e5e994',
    );

    expect(result?.ready).toBe(false);
    expect(saved.at(-1)?.status).toBe(CertificateStatus.ISSUING);
  });

  it('normalizes the scope before it becomes a resource name', async () => {
    const { service, applied } = build();

    await service.ensureForScope(
      'c1',
      `  ${TENANCY_SCOPE.toUpperCase()} `,
      'ns',
    );

    expect(certificateOf(applied)).toContain(
      `- "${tenancyWildcardHost(TENANCY_SCOPE)}"`,
    );
  });

  it('delegates to per-host when no zone covers the scope', async () => {
    const { service } = build({ zone: null });

    await expect(
      service.ensureForScope('c1', TENANCY_SCOPE, 'ns'),
    ).resolves.toBeNull();
  });

  it('refuses loudly when the cluster has no ready DNS-01 issuer', async () => {
    const { service } = build({ issuer: null });

    await expect(
      service.ensureForScope('c1', TENANCY_SCOPE, 'ns'),
    ).rejects.toThrow(/wildcard ClusterIssuer/);
  });
});

describe('WildcardCertificateService.ensureForEndpoint', () => {
  it('derives the tenancy scope from a tenancy hostname and issues for it', async () => {
    const { service, applied } = build();

    await service.ensureForEndpoint(
      'c1',
      `memos.${TENANCY_SCOPE}`,
      'user-guest-f0e5e994',
    );

    expect(applied.find((m) => m.includes('kind: Certificate'))).toContain(
      `- "${tenancyWildcardHost(TENANCY_SCOPE)}"`,
    );
  });
});

describe('WildcardCertificateService.deleteForScope', () => {
  it('takes the master Certificate and Secret away with the row', async () => {
    const { service, repository, kubernetesService } = build();
    repository.findOne.mockResolvedValue({
      id: 'wc-1',
      scope: TENANCY_SCOPE,
      masterNamespace: 'flui-system',
      masterCertName: 'wildcard-x',
      masterSecretName: 'wildcard-x-tls',
    });

    await expect(service.deleteForScope('c1', TENANCY_SCOPE)).resolves.toBe(
      true,
    );

    const kinds = kubernetesService.deleteResource.mock.calls.map((c) => c[1]);
    expect(kinds).toEqual(['Certificate', 'Secret']);
    expect(repository.delete).toHaveBeenCalledWith('wc-1');
  });

  it('says so, without touching the cluster, when there is nothing to remove', async () => {
    const { service, kubernetesService } = build();

    await expect(service.deleteForScope('c1', TENANCY_SCOPE)).resolves.toBe(
      false,
    );
    expect(kubernetesService.deleteResource).not.toHaveBeenCalled();
  });
});
