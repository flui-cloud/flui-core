import { load } from 'js-yaml';
import { AcmeCertificateService } from './acme-certificate.service';
import { DnsProvider } from '../enums/dns-provider.enum';

interface ParsedIssuer {
  spec: {
    acme: {
      email: string;
      solvers: Array<{
        dns01?: {
          webhook: {
            groupName: string;
            solverName: string;
            config: Record<string, { name: string; key: string }>;
          };
        };
        http01?: unknown;
        selector?: { dnsZones?: string[] };
      }>;
    };
  };
}

describe('AcmeCertificateService — wildcard ClusterIssuer', () => {
  const service = new AcmeCertificateService();
  const server = 'https://acme-v02.api.letsencrypt.org/directory';

  const parse = (manifest: string): ParsedIssuer =>
    load(manifest) as unknown as ParsedIssuer;

  it('emits one dns01 solver per DNS provider plus the http01 catch-all', () => {
    const issuer = parse(
      service.generateCombinedClusterIssuerManifest({
        email: 'ops@example.com',
        server,
        solvers: [
          { dnsProvider: DnsProvider.SCALEWAY, zoneNames: ['fluicloud.eu'] },
          {
            dnsProvider: DnsProvider.HETZNER,
            zoneNames: ['dawit.blog', 'other.dev'],
          },
        ],
      }),
    );

    const solvers = issuer.spec.acme.solvers;
    expect(solvers).toHaveLength(3);

    expect(solvers[0].dns01?.webhook.groupName).toBe('acme.scaleway.com');
    expect(solvers[0].selector?.dnsZones).toEqual(['fluicloud.eu']);
    expect(solvers[0].dns01?.webhook.config).toEqual({
      accessKeySecretRef: { name: 'scaleway-secret', key: 'SCW_ACCESS_KEY' },
      secretKeySecretRef: { name: 'scaleway-secret', key: 'SCW_SECRET_KEY' },
    });

    expect(solvers[1].dns01?.webhook.groupName).toBe('acme.hetzner.com');
    expect(solvers[1].selector?.dnsZones).toEqual(['dawit.blog', 'other.dev']);
    expect(solvers[1].dns01?.webhook.config).toEqual({
      tokenSecretKeyRef: { name: 'hetzner-secret', key: 'token' },
    });

    // The catch-all must stay last and selector-less: cert-manager prefers the
    // most specific matching solver, so a zone-selected dns01 solver always
    // wins for its own zones.
    expect(solvers[2].http01).toBeDefined();
    expect(solvers[2].selector).toBeUndefined();
  });

  it('refuses to build a wildcard issuer with no dns01 solver', () => {
    expect(() =>
      service.generateCombinedClusterIssuerManifest({
        email: 'ops@example.com',
        server,
        solvers: [],
      }),
    ).toThrow(/at least one dns01 solver/);
  });

  it('writes the credential Secret with the keys each webhook expects', () => {
    const hetzner = JSON.parse(
      service.generateDnsCredentialSecretManifest(DnsProvider.HETZNER, {
        kind: 'api_token',
        token: 'tok',
      }),
    );
    expect(hetzner.metadata).toMatchObject({
      name: 'hetzner-secret',
      namespace: 'cert-manager',
    });
    expect(hetzner.stringData).toEqual({ token: 'tok' });

    const scaleway = JSON.parse(
      service.generateDnsCredentialSecretManifest(DnsProvider.SCALEWAY, {
        kind: 'access_key_pair',
        accessKey: 'AK',
        secretKey: 'SK',
      }),
    );
    expect(scaleway.metadata.name).toBe('scaleway-secret');
    expect(scaleway.stringData).toEqual({
      SCW_ACCESS_KEY: 'AK',
      SCW_SECRET_KEY: 'SK',
    });
  });

  it('rejects a credential that does not match the webhook shape', () => {
    expect(() =>
      service.generateDnsCredentialSecretManifest(DnsProvider.SCALEWAY, {
        kind: 'api_token',
        token: 'tok',
      }),
    ).toThrow(/expects a access_key_pair credential/);
  });

  it('reports which DNS providers can solve DNS-01', () => {
    expect(service.supportsDns01(DnsProvider.HETZNER)).toBe(true);
    expect(service.supportsDns01(DnsProvider.SCALEWAY)).toBe(true);
    expect(service.supportsDns01(DnsProvider.NONE)).toBe(false);
    expect(() => service.getDns01WebhookConfig(DnsProvider.NONE)).toThrow(
      /not supported for provider "none"/,
    );
  });
});
