jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { EndpointBridgeService } from './endpoint-bridge.service';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';

const CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIB1TCCAT6gAwIBAgIJAMQyOq6yUOEcMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV',
  'BAMMEHNob3AuZXhhbXBsZS5jb20wIBcNMjYxMDExMTY0NzA2WhgPMjEyNjA5MTcx',
  'NjQ3MDZaMBsxGTAXBgNVBAMMEHNob3AuZXhhbXBsZS5jb20wgZ8wDQYJKoZIhvcN',
  'AQEBBQADgY0AMIGJAoGBAPkEtLqph5ArxYScUsl5K7b6D97Gsb5e2h9IJGqOLVV5',
  'DrlbI3VEW1lAijGVRjl2T2QptDVLE1MbIFvuBWtytEa+222YHuAHZ5ys4jcqYkxq',
  'XI6pfpuRJc0gKtuDCyH9wUP1ZmB8TH3OL/e9b5ieiVkdsc+VGsh+oFc2azvDi/Xn',
  'AgMBAAGjHzAdMBsGA1UdEQQUMBKCEHNob3AuZXhhbXBsZS5jb20wDQYJKoZIhvcN',
  'AQELBQADgYEATyrurS3NAGSYn9BgTVtnZPEQ/YNXwhGRun4bhqjCWkF/8MD0rwzW',
  'hLlxxDUL59lHN33C4pU+dhb+Kui7wqJLmgNM/osvxuLp0dMEFxQaywZrquExMlVU',
  'jyYDg0Z6x+CdM2lGIzDnx6+wLU1F2pQyapL5qVKmr0UIcTeBkoLr6Ro=',
  '-----END CERTIFICATE-----',
].join('\n');
const WILDCARD_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBzDCCATWgAwIBAgIJAJAeU3uad7w3MA0GCSqGSIb3DQEBCwUAMBgxFjAUBgNV',
  'BAMMDSouZXhhbXBsZS5jb20wIBcNMjYxMDExMTczNTE4WhgPMjEyNjA5MTcxNzM1',
  'MThaMBgxFjAUBgNVBAMMDSouZXhhbXBsZS5jb20wgZ8wDQYJKoZIhvcNAQEBBQAD',
  'gY0AMIGJAoGBAJfrvcPZp9t+Zg9LP4x8V9J3r71usRKBeAEvjG1tSjE9sZIUlfXm',
  'K3JJHtXcv5HlyemDMo+OjE6TRnakpCbe1NA2Jx3mwXblXF9utYsZOiX4GOPgbv1l',
  'puX739cqJFuDskeW96QVkxZBxgQhNEHV6S6Kqs9w4XDZHEoPYCEY3qXZAgMBAAGj',
  'HDAaMBgGA1UdEQQRMA+CDSouZXhhbXBsZS5jb20wDQYJKoZIhvcNAQELBQADgYEA',
  'H86h8WKcUhso72FCeDGjWYgPAC+RD1GiPZ6KL5N3J3fCYvgcPUqBP0lBJxtwhZ7X',
  'VFcBa3mdUcwip9rM/plkN4HuOe7MJzbB9A7qa7mJx7ophjQb6jtB31+Tl48NqLue',
  'K8Xh9iBLN46oH+ShmHc6CjElBeIIiMLywb1nqQg23vA=',
  '-----END CERTIFICATE-----',
].join('\n');

const tlsSecret = (name: string, pem = CERT) => ({
  metadata: { name },
  type: 'kubernetes.io/tls',
  data: {
    'tls.crt': Buffer.from(pem).toString('base64'),
    'tls.key': Buffer.from('KEY').toString('base64'),
  },
});

const endpoint = (over: Record<string, unknown> = {}): any => ({
  id: 'abcdef12-0000-0000-0000-000000000001',
  fqdn: 'shop.example.com',
  k8sNamespace: 'ns',
  k8sServiceName: 'shop-svc',
  hostnameMode: HostnameMode.DOMAIN,
  certChallenge: CertChallenge.HTTP_01,
  certificateRequired: true,
  certificateProvider: CertificateProvider.LETS_ENCRYPT,
  clusterDnsZoneId: 'za',
  clusterDnsZone: { dnsZoneId: 'dz', dnsZone: { zoneName: 'example.com' } },
  gatewayConfig: null,
  sanCertificateId: null,
  wildcardCertificateId: null,
  tlsSecretName: null,
  ...over,
});

type Store = Record<string, any>;

function setup(
  opts: {
    objects?: Store;
    issuer?: any;
    wildcardEnabled?: boolean;
    wildcardResult?: any;
    secretAppearsOnB?: boolean;
    targetAddresses?: string[];
    issuerAfterSetup?: any;
  } = {},
) {
  let issuer = opts.issuer;
  const objects: Store = {
    'kc-A:apiextensions.k8s.io/v1/CustomResourceDefinition/ingressroutetcps.traefik.io':
      { metadata: {} },
    'kc-A:apiextensions.k8s.io/v1/CustomResourceDefinition/ingressroutes.traefik.io':
      { metadata: {} },
    'kc-A:apiextensions.k8s.io/v1/CustomResourceDefinition/serverstransports.traefik.io':
      { metadata: {} },
    ...opts.objects,
  };
  const clusters: Store = {
    A: { id: 'A', kubeconfigEncrypted: 'kc-A', masterIpAddress: '1.1.1.1' },
    B: {
      id: 'B',
      kubeconfigEncrypted: 'kc-B',
      masterIpAddress: '2.2.2.2',
      metadata: opts.targetAddresses
        ? { ingressAddresses: { addresses: opts.targetAddresses } }
        : {},
    },
  };
  const applied: { kc: string; manifest: any }[] = [];
  const kube = {
    patchKubeconfigServer: (k: string) => k,
    readObject: jest.fn(
      async (kc: string, apiVersion: string, kind: string, name: string) =>
        objects[`${kc}:${apiVersion}/${kind}/${name}`] ?? null,
    ),
    getResource: jest.fn(async (kc: string, kind: string, name: string) => {
      if (kind === 'ClusterIssuer') return issuer ?? null;
      if (
        kind === 'Secret' &&
        kc === 'kc-B' &&
        opts.secretAppearsOnB &&
        applied.some((a) => a.manifest.kind === 'Certificate')
      ) {
        return tlsSecret(name);
      }
      return objects[`${kc}:${kind}/${name}`] ?? null;
    }),
    applyManifest: jest.fn(async (kc: string, text: string) => {
      const manifest = text.trim().startsWith('{')
        ? JSON.parse(text)
        : { kind: /kind: (\w+)/.exec(text)?.[1], text };
      applied.push({ kc, manifest });
      if (manifest.kind === 'Secret') {
        objects[`${kc}:Secret/${manifest.metadata.name}`] = manifest;
      }
      return [];
    }),
    deleteObject: jest.fn(async () => undefined),
    deleteResource: jest.fn(async () => undefined),
  };
  const wildcard = {
    isEnabled: () => opts.wildcardEnabled ?? false,
    ensureForEndpoint: jest.fn(async () => opts.wildcardResult ?? null),
  };
  const acme = {
    getAcmeServerUrl: (p: CertificateProvider) =>
      p === CertificateProvider.LETS_ENCRYPT_STAGING
        ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
        : 'https://acme-v02.api.letsencrypt.org/directory',
    getWildcardIssuerName: (s: string) =>
      s.includes('staging')
        ? 'letsencrypt-staging-wildcard'
        : 'letsencrypt-production-wildcard',
    generateCertificateManifest: (c: any) =>
      `kind: Certificate\nname: ${c.name}\nnamespace: ${c.namespace}\nissuer: ${c.issuerName}\ndns: ${c.domains.join(',')}`,
  };
  const assignments = {
    findOne: jest.fn(async ({ where }: any) =>
      where.clusterId === 'B' && where.dnsZoneId === 'dz'
        ? { id: 'zb', clusterId: 'B', dnsZoneId: 'dz' }
        : null,
    ),
  };
  const zones = {
    resolveAcmeEmail: jest.fn(async () => 'ops@example.com'),
    applyDnsSecret: jest.fn(async () => undefined),
    applyDnsIssuersOnly: jest.fn(async () => {
      if (opts.issuerAfterSetup) issuer = opts.issuerAfterSetup;
    }),
  };
  const service = new EndpointBridgeService(
    { findOne: jest.fn(async ({ where }: any) => clusters[where.id]) } as never,
    assignments as never,
    kube as never,
    { decrypt: (v: string) => v } as never,
    acme as never,
    wildcard as never,
    zones as never,
  );
  service.certificatePollMs = 0;
  service.issuerWaitMs = 0;
  return { service, kube, applied, objects, wildcard, zones };
}

const dns01Issuer = {
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
  spec: {
    acme: {
      solvers: [
        { dns01: { webhook: {} }, selector: { dnsZones: ['example.com'] } },
        { http01: { ingress: {} } },
      ],
    },
  },
};

describe('EndpointBridgeService.preflight', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    endpoints: [endpoint()],
    sourceClusterId: 'A',
    targetClusterId: 'B',
    requested: true,
    ...over,
  });

  it('bridges an ordinary domain endpoint between two reachable clusters', async () => {
    const { service } = setup();
    await expect(service.preflight(input())).resolves.toEqual({
      mode: 'bridge',
      skipReason: null,
    });
  });

  it('records that it was turned off at creation', async () => {
    const { service } = setup();
    await expect(
      service.preflight(input({ requested: false })),
    ).resolves.toEqual({
      mode: 'dns-only',
      skipReason: 'The bridge was turned off when the migration was created.',
    });
  });

  it('falls back when the source cluster cannot route TLS by name', async () => {
    const { service } = setup({
      objects: {
        'kc-A:apiextensions.k8s.io/v1/CustomResourceDefinition/ingressroutetcps.traefik.io':
          null,
      },
    });
    const verdict = await service.preflight(input());
    expect(verdict.mode).toBe('dns-only');
    expect(verdict.skipReason).toMatch(/ingressroutetcps\.traefik\.io/);
  });

  it('falls back when an endpoint keeps an IP allow-list', async () => {
    const { service } = setup();
    const verdict = await service.preflight(
      input({
        endpoints: [endpoint({ gatewayConfig: { allowIps: ['10.0.0.1'] } })],
      }),
    );
    expect(verdict.mode).toBe('dns-only');
    expect(verdict.skipReason).toMatch(/IP allow-list/);
  });
});

describe('EndpointBridgeService.zonesMissingOn', () => {
  it('names the zones the destination has no assignment for', async () => {
    const { service } = setup();
    await expect(service.zonesMissingOn([endpoint()], 'B')).resolves.toEqual(
      [],
    );
    await expect(
      service.zonesMissingOn(
        [
          endpoint({
            clusterDnsZone: {
              dnsZoneId: 'other',
              dnsZone: { zoneName: 'x.org' },
            },
          }),
        ],
        'B',
      ),
    ).resolves.toEqual(['x.org']);
  });
});

describe('EndpointBridgeService.prepare (certificate on the destination before activation)', () => {
  const prepare = (service: EndpointBridgeService) =>
    service.prepare({
      bridgeId: 'mig-1',
      endpoints: [endpoint()],
      sourceClusterId: 'A',
      targetClusterId: 'B',
      waitMs: 0,
    });

  it('issues the certificate on the destination through DNS-01 when its issuer solves the zone', async () => {
    const { service, applied } = setup({
      issuer: dns01Issuer,
      secretAppearsOnB: true,
    });

    const [host] = await prepare(service);

    const cert = applied.find((a) => a.manifest.kind === 'Certificate');
    expect(cert.kc).toBe('kc-B');
    expect(cert.manifest.text).toContain(
      'issuer: letsencrypt-production-wildcard',
    );
    expect(cert.manifest.text).toContain('name: tls-shop-example-com');
    expect(host).toEqual(
      expect.objectContaining({
        fqdn: 'shop.example.com',
        certificate: 'dns-01',
        secretName: 'tls-shop-example-com',
        certificateReady: true,
      }),
    );
  });

  it('copies the source certificate when the destination cannot solve DNS-01 for the zone', async () => {
    const { service, applied, objects } = setup({
      objects: {
        'kc-A:Ingress/shop-svc-abcdef12-ingress': {
          spec: { tls: [{ secretName: 'tls-shop-example-com' }] },
        },
        'kc-A:Secret/tls-shop-example-com': tlsSecret('tls-shop-example-com'),
      },
    });

    const [host] = await prepare(service);

    const copy = applied.find((a) => a.manifest.kind === 'Secret');
    expect(copy.kc).toBe('kc-B');
    expect(copy.manifest.type).toBe('kubernetes.io/tls');
    expect(copy.manifest.metadata.labels['flui.cloud/bridge-id']).toBe('mig-1');
    expect(objects['kc-B:Secret/tls-shop-example-com'].data['tls.crt']).toBe(
      Buffer.from(CERT).toString('base64'),
    );
    expect(host.certificate).toBe('copied');
    expect(host.certificateReady).toBe(true);
  });

  it('prepares the destination wildcard when the endpoint will be bound to it there', async () => {
    const { service, wildcard } = setup({
      wildcardEnabled: true,
      wildcardResult: {
        wildcardCertificateId: 'w1',
        tlsSecretName: 'wildcard-example-com-tls',
        ready: true,
      },
      objects: {
        'kc-B:Secret/wildcard-example-com-tls': tlsSecret('w'),
      },
    });

    const [host] = await service.prepare({
      bridgeId: 'mig-1',
      endpoints: [endpoint({ certChallenge: CertChallenge.DNS_01 })],
      sourceClusterId: 'A',
      targetClusterId: 'B',
      waitMs: 0,
    });

    expect(wildcard.ensureForEndpoint).toHaveBeenCalledWith(
      'B',
      'shop.example.com',
      'ns',
    );
    expect(host).toEqual(
      expect.objectContaining({
        certificate: 'wildcard',
        secretName: 'wildcard-example-com-tls',
        certificateReady: true,
      }),
    );
  });

  it('reports a name that has no valid certificate to copy', async () => {
    const { service } = setup();

    const [host] = await prepare(service);

    expect(host.certificateReady).toBe(false);
    expect(host.certificateMessage).toMatch(/no valid certificate/);
  });
});

describe('EndpointBridgeService.prepare after review', () => {
  const prepare = (service: EndpointBridgeService) =>
    service.prepare({
      bridgeId: 'mig-1',
      endpoints: [endpoint()],
      sourceClusterId: 'A',
      targetClusterId: 'B',
      waitMs: 0,
    });

  it('never copies a wildcard certificate into the destination namespace', async () => {
    const { service, applied } = setup({
      objects: {
        'kc-A:Ingress/shop-svc-abcdef12-ingress': {
          spec: { tls: [{ secretName: 'wildcard-example-com-tls' }] },
        },
        'kc-A:Secret/wildcard-example-com-tls': tlsSecret('w', WILDCARD_CERT),
      },
    });

    const [host] = await prepare(service);

    expect(applied.some((a) => a.manifest.kind === 'Secret')).toBe(false);
    expect(host.certificateReady).toBe(false);
    expect(host.certificateMessage).toMatch(/wildcard/);
  });

  it('brings the DNS-01 issuer up on the destination before falling back to a copy', async () => {
    const { service, applied, zones } = setup({
      issuerAfterSetup: dns01Issuer,
      secretAppearsOnB: true,
      objects: {
        'kc-A:Ingress/shop-svc-abcdef12-ingress': {
          spec: { tls: [{ secretName: 'tls-shop-example-com' }] },
        },
        'kc-A:Secret/tls-shop-example-com': tlsSecret('tls-shop-example-com'),
      },
    });

    const [host] = await prepare(service);

    expect(zones.applyDnsSecret).toHaveBeenCalledWith('B');
    expect(zones.applyDnsIssuersOnly).toHaveBeenCalledWith('B', {
      acmeEmail: 'ops@example.com',
    });
    expect(applied.some((a) => a.manifest.kind === 'Secret')).toBe(false);
    expect(host.certificate).toBe('dns-01');
  });
});

describe('EndpointBridgeService.certificatesValid', () => {
  it('refuses activation while a bridged name has no valid certificate on the destination', async () => {
    const { service } = setup();
    const hosts: any[] = [
      {
        fqdn: 'shop.example.com',
        namespace: 'ns',
        endpointIds: ['e1'],
        secretName: 'tls-shop-example-com',
        certificate: 'dns-01',
        certificateReady: true,
        certificateMessage: null,
        certificateRequired: true,
      },
    ];
    await expect(service.certificatesValid(hosts, 'B')).resolves.toMatch(
      /shop\.example\.com/,
    );
  });

  it('lets activation through once the destination secret holds a valid certificate', async () => {
    const { service } = setup({
      objects: { 'kc-B:Secret/tls-shop-example-com': tlsSecret('x') },
    });
    const hosts: any[] = [
      {
        fqdn: 'shop.example.com',
        namespace: 'ns',
        endpointIds: ['e1'],
        secretName: 'tls-shop-example-com',
        certificate: 'dns-01',
        certificateReady: true,
        certificateMessage: null,
        certificateRequired: true,
      },
    ];
    await expect(service.certificatesValid(hosts, 'B')).resolves.toBeNull();
  });
});

describe('EndpointBridgeService.activate and close', () => {
  const hosts: any[] = [
    {
      fqdn: 'shop.example.com',
      namespace: 'ns',
      endpointIds: ['abcdef12-0000-0000-0000-000000000001'],
      secretName: 'tls-shop-example-com',
      certificate: 'copied',
      certificateReady: true,
      certificateMessage: null,
      certificateRequired: true,
    },
  ];

  it('applies the forwarding objects on the source, pointed at the destination ingress', async () => {
    const { service, applied } = setup({
      targetAddresses: ['2.2.2.2', '2.2.2.3'],
    });

    await expect(service.activate('mig-1', hosts, 'A', 'B')).resolves.toEqual([
      '2.2.2.2',
      '2.2.2.3',
    ]);

    expect(applied.every((a) => a.kc === 'kc-A')).toBe(true);
    expect(applied.map((a) => a.manifest.kind).sort()).toEqual([
      'EndpointSlice',
      'Endpoints',
      'IngressRoute',
      'IngressRouteTCP',
      'Service',
    ]);
  });

  it('removes them again on close', async () => {
    const { service, kube } = setup();

    await expect(service.close(hosts, 'A')).resolves.toBeNull();

    expect(kube.deleteObject).toHaveBeenCalledTimes(7);
    expect(
      kube.deleteObject.mock.calls.every((c: any[]) => c[0] === 'kc-A'),
    ).toBe(true);
    expect(kube.deleteObject).toHaveBeenCalledWith(
      'kc-A',
      'traefik.io/v1alpha1',
      'IngressRoute',
      'flui-bridge-abcdef12-tail',
      'ns',
    );
  });

  it('removes the certificates it placed on the destination when the migration is dropped', async () => {
    const { service, kube } = setup();

    await service.discard(hosts, 'B');

    expect(kube.deleteResource).toHaveBeenCalledWith(
      'kc-B',
      'Secret',
      'tls-shop-example-com',
      'ns',
    );
  });
});
