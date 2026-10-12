import {
  BRIDGE_ROUTE_PRIORITY,
  bridgeObjectRefs,
  certificateProblem,
  dns01IssuerServes,
  groupBridgeHosts,
  perHostSecretName,
  renderBridgeCertificateSecret,
  renderBridgeObjects,
  staticBridgeBlocker,
} from './endpoint-bridge.core';
import { HostnameMode } from '../enums/hostname-mode.enum';

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

const spec = {
  bridgeId: 'mig-1234',
  fqdn: 'shop.example.com',
  namespace: 'proj-a',
  anchorEndpointId: 'abcdef12-3456-7890-abcd-ef1234567890',
  targetAddresses: ['51.15.1.2', '51.15.1.3'],
};

const byKind = (objects: any[], kind: string, name?: string) =>
  objects.filter(
    (o) => o.kind === kind && (name === undefined || o.metadata.name === name),
  );

describe('renderBridgeObjects', () => {
  const objects = renderBridgeObjects(spec) as any[];

  it('labels every object with the bridge and the endpoint it forwards', () => {
    for (const o of objects) {
      expect(o.metadata.namespace).toBe('proj-a');
      expect(o.metadata.labels).toEqual(
        expect.objectContaining({
          'managed-by': 'flui-cloud',
          'flui-resource-type': 'migration-bridge',
          'flui.cloud/bridge-id': 'mig-1234',
          'flui-endpoint-id': spec.anchorEndpointId,
        }),
      );
    }
  });

  it('sends the raw TLS stream for the name to the destination on 443', () => {
    const [tcp] = byKind(objects, 'IngressRouteTCP');
    expect(tcp.apiVersion).toBe('traefik.io/v1alpha1');
    expect(tcp.metadata.name).toBe('flui-bridge-abcdef12-tls');
    expect(tcp.spec).toEqual({
      entryPoints: ['websecure'],
      routes: [
        {
          match: 'HostSNI(`shop.example.com`)',
          services: [{ name: 'flui-bridge-abcdef12', port: 443 }],
        },
      ],
      tls: { passthrough: true },
    });
  });

  it('reaches the destination through a selectorless Service and a hand-made EndpointSlice', () => {
    const [svc] = byKind(objects, 'Service');
    expect(svc.spec.selector).toBeUndefined();
    expect(svc.spec.ports).toEqual([
      { name: 'https', port: 443, targetPort: 443, protocol: 'TCP' },
      { name: 'http', port: 80, targetPort: 80, protocol: 'TCP' },
    ]);
    const [slice] = byKind(objects, 'EndpointSlice');
    expect(slice.apiVersion).toBe('discovery.k8s.io/v1');
    expect(slice.metadata.labels['kubernetes.io/service-name']).toBe(
      'flui-bridge-abcdef12',
    );
    expect(slice.addressType).toBe('IPv4');
    expect(slice.endpoints).toEqual([
      { addresses: ['51.15.1.2'], conditions: { ready: true } },
      { addresses: ['51.15.1.3'], conditions: { ready: true } },
    ]);
  });

  it('proxies plain HTTP for the name to the destination on a high-priority route', () => {
    const [web] = byKind(objects, 'IngressRoute', 'flui-bridge-abcdef12-web');
    expect(web.spec.entryPoints).toEqual(['web']);
    expect(web.spec.routes[0]).toEqual({
      match: 'Host(`shop.example.com`)',
      kind: 'Rule',
      priority: BRIDGE_ROUTE_PRIORITY,
      services: [
        { name: 'flui-bridge-abcdef12', port: 80, passHostHeader: true },
      ],
    });
  });

  // On Traefik 3.6 an HTTP router with TLS on websecure for the same Host takes
  // the SNI from the passthrough router, and the source answers with its
  // default certificate.
  it('never terminates TLS for the name on the source', () => {
    expect(
      objects.filter(
        (o) =>
          o.kind === 'IngressRoute' && o.spec.entryPoints.includes('websecure'),
      ),
    ).toEqual([]);
    expect(byKind(objects, 'ServersTransport')).toEqual([]);
    expect(objects.map((o) => o.kind).sort()).toEqual([
      'EndpointSlice',
      'Endpoints',
      'IngressRoute',
      'IngressRouteTCP',
      'Service',
    ]);
  });

  it('also writes the legacy Endpoints object older Traefik reads, kept out of slice mirroring', () => {
    const [legacy] = byKind(objects, 'Endpoints');
    expect(legacy.apiVersion).toBe('v1');
    expect(legacy.metadata.name).toBe('flui-bridge-abcdef12');
    expect(
      legacy.metadata.labels['endpointslice.kubernetes.io/skip-mirror'],
    ).toBe('true');
    expect(legacy.subsets).toEqual([
      {
        addresses: [{ ip: '51.15.1.2' }, { ip: '51.15.1.3' }],
        ports: [
          { name: 'https', port: 443, protocol: 'TCP' },
          { name: 'http', port: 80, protocol: 'TCP' },
        ],
      },
    ]);
  });

  it('matches the name in lower case, as clients send it', () => {
    const mixed = renderBridgeObjects({
      ...spec,
      fqdn: 'Shop.Example.com',
    }) as any[];
    const [tcp] = byKind(mixed, 'IngressRouteTCP');
    expect(tcp.spec.routes[0].match).toBe('HostSNI(`shop.example.com`)');
    const [web] = byKind(mixed, 'IngressRoute', 'flui-bridge-abcdef12-web');
    expect(web.spec.routes[0].match).toBe('Host(`shop.example.com`)');
  });

  it('refuses a wildcard name, which HostSNI cannot match', () => {
    expect(() =>
      renderBridgeObjects({ ...spec, fqdn: '*.example.com' }),
    ).toThrow(/wildcard/);
  });

  it('names exactly the objects it renders, for closing', () => {
    const refs = bridgeObjectRefs('proj-a', spec.anchorEndpointId);
    expect(refs.map((r) => `${r.kind}/${r.name}`).sort()).toEqual(
      objects.map((o) => `${o.kind}/${o.metadata.name}`).sort(),
    );
    for (const r of refs) {
      const rendered = objects.find(
        (o) => o.kind === r.kind && o.metadata.name === r.name,
      );
      expect(r.apiVersion).toBe(rendered.apiVersion);
    }
  });
});

describe('certificateProblem', () => {
  const now = new Date('2030-01-01T00:00:00Z');

  it('accepts a current certificate for the name', () => {
    expect(certificateProblem(CERT, 'shop.example.com', now)).toBeNull();
  });

  it('rejects a certificate for another name', () => {
    expect(certificateProblem(CERT, 'blog.example.com', now)).toMatch(
      /does not cover blog\.example\.com/,
    );
  });

  it('rejects an expired certificate', () => {
    expect(
      certificateProblem(CERT, 'shop.example.com', new Date('2200-01-01')),
    ).toMatch(/expired/);
  });

  it('rejects something that is not a certificate', () => {
    expect(certificateProblem('nope', 'shop.example.com', now)).toMatch(
      /not a readable certificate/,
    );
  });
});

describe('groupBridgeHosts', () => {
  it('makes one host per name, keeping every endpoint answering on it', () => {
    expect(
      groupBridgeHosts([
        { id: 'e1', fqdn: 'shop.example.com', k8sNamespace: 'ns' },
        { id: 'e2', fqdn: 'shop.example.com', k8sNamespace: 'ns' },
        { id: 'e3', fqdn: 'api.example.com', k8sNamespace: 'ns' },
      ] as any),
    ).toEqual([
      { fqdn: 'shop.example.com', namespace: 'ns', endpointIds: ['e1', 'e2'] },
      { fqdn: 'api.example.com', namespace: 'ns', endpointIds: ['e3'] },
    ]);
  });
});

describe('staticBridgeBlocker', () => {
  const ok = {
    id: 'e1',
    fqdn: 'shop.example.com',
    hostnameMode: HostnameMode.DOMAIN,
    clusterDnsZoneId: 'z1',
    gatewayConfig: null,
    sanCertificateId: null,
  };

  it('lets an ordinary domain endpoint through', () => {
    expect(staticBridgeBlocker([ok] as any)).toBeNull();
  });

  it('says why an application without an address cannot be bridged', () => {
    expect(staticBridgeBlocker([])).toMatch(/no address/);
  });

  it('keeps an IP allow-list away from the bridge, which hides the client address', () => {
    expect(
      staticBridgeBlocker([
        { ...ok, gatewayConfig: { allowIps: ['10.0.0.0/8'] } },
      ] as any),
    ).toMatch(/IP allow-list/);
  });

  it('refuses wildcard names, names outside a Flui zone and SAN certificates', () => {
    expect(
      staticBridgeBlocker([{ ...ok, fqdn: '*.example.com' }] as any),
    ).toMatch(/wildcard/);
    expect(
      staticBridgeBlocker([{ ...ok, clusterDnsZoneId: null }] as any),
    ).toMatch(/not managed by Flui/);
    expect(
      staticBridgeBlocker([{ ...ok, sanCertificateId: 'san-1' }] as any),
    ).toMatch(/shared certificate/);
  });
});

describe('perHostSecretName', () => {
  it('names the secret after the host, dots and stars made safe', () => {
    expect(perHostSecretName('shop.example.com')).toBe('tls-shop-example-com');
    expect(perHostSecretName('*.example.com')).toBe('tls-wildcard-example-com');
  });
});

describe('dns01IssuerServes', () => {
  const issuer = (ready: string, zones: string[], dns01 = true) => ({
    status: { conditions: [{ type: 'Ready', status: ready }] },
    spec: {
      acme: {
        solvers: [
          { ...(dns01 ? { dns01: {} } : {}), selector: { dnsZones: zones } },
        ],
      },
    },
  });

  it('accepts a Ready issuer whose DNS-01 solver covers the zone', () => {
    expect(
      dns01IssuerServes(issuer('True', ['Example.com']), 'Shop.example.com'),
    ).toBe(true);
    expect(
      dns01IssuerServes(issuer('True', ['example.com']), 'example.com'),
    ).toBe(true);
  });

  it('refuses an issuer that is not Ready, misses the zone or has no DNS-01 solver', () => {
    expect(
      dns01IssuerServes(issuer('False', ['example.com']), 'shop.example.com'),
    ).toBe(false);
    expect(
      dns01IssuerServes(issuer('True', ['other.com']), 'shop.example.com'),
    ).toBe(false);
    expect(
      dns01IssuerServes(
        issuer('True', ['example.com'], false),
        'shop.example.com',
      ),
    ).toBe(false);
    expect(dns01IssuerServes(null, 'shop.example.com')).toBe(false);
  });
});

describe('renderBridgeCertificateSecret', () => {
  it('labels the copied TLS secret with the bridge that placed it', () => {
    const secret = renderBridgeCertificateSecret({
      bridgeId: 'mig-1',
      secretName: 'tls-shop-example-com',
      namespace: 'ns',
      crt: 'CRT',
      key: 'KEY',
    }) as any;
    expect(secret.type).toBe('kubernetes.io/tls');
    expect(secret.metadata).toEqual({
      name: 'tls-shop-example-com',
      namespace: 'ns',
      labels: {
        'managed-by': 'flui-cloud',
        'flui-resource-type': 'migration-bridge-certificate',
        'flui.cloud/bridge-id': 'mig-1',
      },
    });
    expect(secret.data).toEqual({ 'tls.crt': 'CRT', 'tls.key': 'KEY' });
  });
});
