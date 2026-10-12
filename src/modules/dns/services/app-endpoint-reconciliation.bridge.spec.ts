jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { AppEndpointReconciliationService } from './app-endpoint-reconciliation.service';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { EndpointType } from '../enums/endpoint-type.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';

const A_IP = '1.1.1.1';
const B_IP = '2.2.2.2';

function setup(
  over: Record<string, unknown> = {},
  ingressesOnA: unknown[] = [],
  issuers: unknown[] = [{ name: 'letsencrypt-production', ready: true }],
) {
  const endpoint: any = {
    id: 'ep-1',
    fqdn: 'shop.example.com',
    clusterId: 'B',
    hostnameMode: HostnameMode.DOMAIN,
    endpointType: EndpointType.PUBLIC,
    certChallenge: CertChallenge.HTTP_01,
    certificateRequired: true,
    certificateProvider: CertificateProvider.LETS_ENCRYPT,
    k8sNamespace: 'ns',
    k8sServiceName: 'shop-svc',
    k8sServicePort: 80,
    dnsRecordType: DnsRecordType.A,
    dnsRecordId: 'shop/A',
    dnsRecordValue: A_IP,
    dnsHeldBy: null,
    wildcardCertificateId: null,
    sanCertificateId: null,
    gatewayConfig: null,
    clusterDnsZone: {
      id: 'z-b',
      dnsZone: {
        zoneName: 'example.com',
        providerZoneId: 'pz',
        dnsProvider: 'hetzner',
        recordTtlSeconds: 300,
      },
    },
    ...over,
  };
  const clusters: Record<string, any> = {
    A: { id: 'A', kubeconfigEncrypted: 'kc-A', masterIpAddress: A_IP },
    B: { id: 'B', kubeconfigEncrypted: 'kc-B', masterIpAddress: B_IP },
  };
  const provider = {
    listRecords: jest.fn(async () => [
      {
        recordId: 'r1',
        zoneId: 'pz',
        type: DnsRecordType.A,
        name: 'shop',
        value: A_IP,
        ttl: 300,
      },
    ]),
    setRecordValues: jest.fn(async (c: any) =>
      c.values.map((value: string) => ({ ...c, value, recordId: 'r2' })),
    ),
    deleteRecord: jest.fn(),
  };
  const applied: any[] = [];
  const kube = {
    patchKubeconfigServer: (k: string) => k,
    getResource: jest.fn(async () => null),
    applyManifest: jest.fn(async (_kc: string, json: string) => {
      applied.push(JSON.parse(json));
    }),
    deleteResource: jest.fn(async () => undefined),
    listResourcesByLabel: jest.fn(async () => []),
    listCrdResources: jest.fn(async () => ingressesOnA),
  };
  const endpoints = {
    getEndpoint: jest.fn(async () => endpoint),
    updateReconciliationStatus: jest.fn(),
    markReconciliationComplete: jest.fn(),
    otherRoutesOnHost: jest.fn(async () => []),
    clearDnsRecord: jest.fn(),
    listByNamespace: jest.fn(async () => []),
  };
  const acme = {
    getAcmeServerUrl: () => 'https://acme-v02.api.letsencrypt.org/directory',
    getIssuerName: () => 'letsencrypt-production',
    getWildcardIssuerName: () => 'letsencrypt-production-wildcard',
  };
  const zones = {
    getIssuers: jest.fn(async () => issuers),
  };
  const service = new AppEndpointReconciliationService(
    { findOne: jest.fn(async ({ where }: any) => clusters[where.id]) } as never,
    kube as never,
    { decrypt: (v: string) => v } as never,
    { getDnsProviderOrFail: () => provider } as never,
    acme as never,
    endpoints as never,
    zones as never,
    null as never,
    { isEnabled: () => false } as never,
    null as never,
    { emitEndpointCertStatus: jest.fn() } as never,
    {
      fanOutRecordToReplicas: jest.fn(),
      fanOutDeleteToReplicas: jest.fn(),
    } as never,
    {
      compile: () => ({ middlewares: [], refs: [], path: '/' }),
      allMiddlewareNames: () => [],
    } as never,
    { exists: jest.fn(async () => false) } as never,
    { ensure: jest.fn() } as never,
  );
  return { service, endpoint, provider, kube, applied, endpoints };
}

const ingressOf = (applied: any[]) => applied.find((m) => m.kind === 'Ingress');

describe('reconciling an endpoint whose DNS a migration holds', () => {
  it('builds the route on the endpoint cluster without touching DNS or deferring the certificate', async () => {
    const { service, provider, applied, endpoints } = setup({
      dnsHeldBy: 'mig-1',
    });

    await expect(service.reconcile('ep-1')).resolves.toBe(true);

    expect(provider.listRecords).not.toHaveBeenCalled();
    expect(provider.setRecordValues).not.toHaveBeenCalled();
    const ingress = ingressOf(applied);
    expect(ingress.metadata.labels['flui-cluster-id']).toBe('B');
    expect(
      ingress.metadata.annotations['cert-manager.io/cluster-issuer'],
    ).toBeUndefined();
    expect(ingress.spec.tls).toEqual([
      { hosts: ['shop.example.com'], secretName: 'tls-shop-example-com' },
    ]);
    const [, recordId, recordValue, , , , deferredSince] =
      endpoints.markReconciliationComplete.mock.calls[0];
    expect(recordId).toBeUndefined();
    expect(recordValue).toBeUndefined();
    expect(deferredSince).toBeNull();
  });

  it('serves the prepared certificate even before the destination has a ready issuer', async () => {
    const { service, applied } = setup({ dnsHeldBy: 'mig-1' }, [], []);

    await service.reconcile('ep-1');

    expect(ingressOf(applied).spec.tls).toEqual([
      { hosts: ['shop.example.com'], secretName: 'tls-shop-example-com' },
    ]);
  });

  it('does not wait for a name that already resolves when asked to move it', async () => {
    const { service, applied, provider } = setup();
    jest
      .spyOn(service as any, 'waitForAuthoritativeDnsPropagation')
      .mockResolvedValue({ published: false, detail: 'not yet' });

    await service.reconcile('ep-1', { nameAlreadyPublished: true });

    expect(provider.setRecordValues).toHaveBeenCalledWith(
      expect.objectContaining({ values: [B_IP] }),
    );
    expect(
      ingressOf(applied).metadata.annotations['cert-manager.io/cluster-issuer'],
    ).toBe('letsencrypt-production');
  });

  it('still defers a brand-new name until its nameservers answer', async () => {
    const { service, applied } = setup();
    jest
      .spyOn(service as any, 'waitForAuthoritativeDnsPropagation')
      .mockResolvedValue({ published: false, detail: 'not yet' });

    await service.reconcile('ep-1');

    expect(
      ingressOf(applied).metadata.annotations['cert-manager.io/cluster-issuer'],
    ).toBeUndefined();
  });
});

describe('removing what an endpoint left on a cluster it no longer lives on', () => {
  it('deletes the route, its certificate and policies there and leaves DNS alone', async () => {
    const { service, kube, provider, endpoints } = setup();

    await service.deleteEndpointResources('ep-1', { clusterId: 'A' });

    const deleted = kube.deleteResource.mock.calls.map(
      (c: any[]) => `${c[0]}:${c[1]}/${c[2]}`,
    );
    expect(deleted).toEqual(
      expect.arrayContaining([
        'kc-A:Ingress/shop-svc-ep-ingress',
        'kc-A:Certificate/tls-shop-example-com',
        'kc-A:Secret/tls-shop-example-com',
      ]),
    );
    expect(deleted.some((d: string) => d.startsWith('kc-B'))).toBe(false);
    expect(provider.listRecords).not.toHaveBeenCalled();
    expect(provider.deleteRecord).not.toHaveBeenCalled();
    expect(endpoints.clearDnsRecord).not.toHaveBeenCalled();
  });

  it('removes the per-host certificate on the old cluster even when the row now names a wildcard of the new one', async () => {
    const { service, kube } = setup({
      wildcardCertificateId: 'wild-b',
      tlsSecretName: 'wildcard-example-com-tls',
    });

    await service.deleteEndpointResources('ep-1', { clusterId: 'A' });

    const deleted = kube.deleteResource.mock.calls.map(
      (c: any[]) => `${c[0]}:${c[1]}/${c[2]}`,
    );
    expect(deleted).toEqual(
      expect.arrayContaining([
        'kc-A:Certificate/tls-shop-example-com',
        'kc-A:Secret/tls-shop-example-com',
      ]),
    );
  });

  it('keeps the certificate when another route on the old cluster still serves it', async () => {
    const { service, kube } = setup({}, [
      {
        metadata: { name: 'other-ingress', namespace: 'ns' },
        spec: { tls: [{ secretName: 'tls-shop-example-com' }] },
      },
    ]);

    await service.deleteEndpointResources('ep-1', { clusterId: 'A' });

    const kinds = kube.deleteResource.mock.calls.map((c: any[]) => c[1]);
    expect(kinds).toContain('Ingress');
    expect(kinds).not.toContain('Certificate');
    expect(kinds).not.toContain('Secret');
  });

  it('can leave the certificate in place when asked to', async () => {
    const { service, kube } = setup();

    await service.deleteEndpointResources('ep-1', {
      clusterId: 'A',
      keepCertificate: true,
    });

    const kinds = kube.deleteResource.mock.calls.map((c: any[]) => c[1]);
    expect(kinds).toContain('Ingress');
    expect(kinds).not.toContain('Certificate');
    expect(kinds).not.toContain('Secret');
  });

  it('refuses to strip the cluster the endpoint is served from', async () => {
    const { service, kube } = setup();

    await expect(
      service.deleteEndpointResources('ep-1', { clusterId: 'B' }),
    ).rejects.toThrow(/serves/);
    expect(kube.deleteResource).not.toHaveBeenCalled();
  });
});

describe('reading what the DNS provider answers for an endpoint', () => {
  it('returns the published values, the TTL and what the endpoint cluster expects', async () => {
    const { service } = setup();

    await expect(service.publishedAnswer('ep-1')).resolves.toEqual({
      published: [A_IP],
      expected: [B_IP],
      ttl: 300,
    });
  });

  it('has nothing to say for a name Flui does not publish', async () => {
    const { service } = setup({ clusterDnsZone: null });

    await expect(service.publishedAnswer('ep-1')).resolves.toBeNull();
  });
});

describe('preparing the route on the destination before the cutover', () => {
  it('builds the Ingress there with the prepared secret, leaving the row and DNS alone', async () => {
    const { service, applied, provider, endpoints, kube } = setup({
      clusterId: 'A',
    });

    await service.prepareRouteOn('ep-1', 'B', 'tls-shop-example-com');

    const ingress = ingressOf(applied);
    expect(ingress.metadata.labels['flui-cluster-id']).toBe('B');
    expect(
      ingress.metadata.annotations['cert-manager.io/cluster-issuer'],
    ).toBeUndefined();
    expect(ingress.spec.tls).toEqual([
      { hosts: ['shop.example.com'], secretName: 'tls-shop-example-com' },
    ]);
    expect(
      kube.applyManifest.mock.calls.every((c: any[]) => c[0] === 'kc-B'),
    ).toBe(true);
    expect(provider.listRecords).not.toHaveBeenCalled();
    expect(endpoints.markReconciliationComplete).not.toHaveBeenCalled();
    expect(endpoints.updateReconciliationStatus).not.toHaveBeenCalled();
  });

  it('serves the destination wildcard when that is what was prepared', async () => {
    const { service, applied } = setup({ clusterId: 'A' });

    await service.prepareRouteOn('ep-1', 'B', 'wildcard-example-com-tls');

    expect(ingressOf(applied).spec.tls).toEqual([
      { hosts: ['shop.example.com'], secretName: 'wildcard-example-com-tls' },
    ]);
  });

  it('makes sure the destination issuer is ready, so the cutover does not bootstrap it', async () => {
    const { service } = setup({ clusterId: 'A' });
    const ensure = jest.spyOn(service as any, 'resolveReadyIssuerOrSelfHeal');

    await service.prepareRouteOn('ep-1', 'B', 'tls-shop-example-com');

    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: 'B' }),
      expect.objectContaining({ id: 'B' }),
      CertificateProvider.LETS_ENCRYPT,
    );
  });
});
