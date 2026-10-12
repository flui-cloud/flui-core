import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { ENDPOINT_ID_LABEL } from '../constants/endpoint-labels';

/** Above any rule-length priority Traefik derives for the source's own Ingress. */
export const BRIDGE_ROUTE_PRIORITY = 100000;

export const BRIDGE_ID_LABEL = 'flui.cloud/bridge-id';

const TRAEFIK = 'traefik.io/v1alpha1';
const FLUI_MANAGER = 'flui-cloud';

export interface BridgeHostSpec {
  bridgeId: string;
  fqdn: string;
  namespace: string;
  anchorEndpointId: string;
  targetAddresses: string[];
}

export interface BridgeObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
}

export function bridgeObjectName(anchorEndpointId: string): string {
  return `flui-bridge-${anchorEndpointId.split('-')[0]}`;
}

export function bridgeObjectRefs(
  namespace: string,
  anchorEndpointId: string,
): BridgeObjectRef[] {
  const name = bridgeObjectName(anchorEndpointId);
  return [
    { apiVersion: 'v1', kind: 'Service', name },
    { apiVersion: 'v1', kind: 'Endpoints', name },
    {
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      name: `${name}-1`,
    },
    { apiVersion: TRAEFIK, kind: 'IngressRouteTCP', name: `${name}-tls` },
    { apiVersion: TRAEFIK, kind: 'IngressRoute', name: `${name}-web` },
  ].map((ref) => ({ ...ref, namespace }));
}

/** Objects earlier bridges rendered and no longer do; closing removes them too. */
export function retiredBridgeObjectRefs(
  namespace: string,
  anchorEndpointId: string,
): BridgeObjectRef[] {
  const name = bridgeObjectName(anchorEndpointId);
  return [
    { apiVersion: TRAEFIK, kind: 'ServersTransport', name },
    { apiVersion: TRAEFIK, kind: 'IngressRoute', name: `${name}-tail` },
  ].map((ref) => ({ ...ref, namespace }));
}

/**
 * The objects on the source cluster that forward one hostname to the
 * destination ingress: TLS passes through untouched on 443 and port 80 is
 * proxied as plain HTTP. Nothing terminates TLS for the name on the source:
 * an HTTPS router for the same Host on websecure takes the SNI away from the
 * passthrough router (seen on Traefik 3.6), so connections already open on the
 * source end when its pods stop and clients reconnect through the passthrough.
 */
export function renderBridgeObjects(
  spec: BridgeHostSpec,
): Record<string, unknown>[] {
  if (spec.fqdn.startsWith('*.')) {
    throw new Error(
      `${spec.fqdn} is a wildcard name; the bridge forwards one exact name at a time`,
    );
  }
  const name = bridgeObjectName(spec.anchorEndpointId);
  const metadata = (
    objectName: string,
    extra: Record<string, string> = {},
  ) => ({
    name: objectName,
    namespace: spec.namespace,
    labels: {
      'managed-by': FLUI_MANAGER,
      'flui-resource-type': 'migration-bridge',
      [BRIDGE_ID_LABEL]: spec.bridgeId,
      [ENDPOINT_ID_LABEL]: spec.anchorEndpointId,
      ...extra,
    },
  });
  const fqdn = spec.fqdn.toLowerCase();
  const host = `Host(\`${fqdn}\`)`;

  return [
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(name),
      spec: {
        type: 'ClusterIP',
        ports: [
          { name: 'https', port: 443, targetPort: 443, protocol: 'TCP' },
          { name: 'http', port: 80, targetPort: 80, protocol: 'TCP' },
        ],
      },
    },
    // Traefik before 3.1 reads Endpoints, later ones EndpointSlices; skip-mirror avoids a duplicate slice.
    {
      apiVersion: 'v1',
      kind: 'Endpoints',
      metadata: metadata(name, {
        'endpointslice.kubernetes.io/skip-mirror': 'true',
      }),
      subsets: [
        {
          addresses: spec.targetAddresses.map((ip) => ({ ip })),
          ports: [
            { name: 'https', port: 443, protocol: 'TCP' },
            { name: 'http', port: 80, protocol: 'TCP' },
          ],
        },
      ],
    },
    {
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: metadata(`${name}-1`, {
        'kubernetes.io/service-name': name,
        'endpointslice.kubernetes.io/managed-by': FLUI_MANAGER,
      }),
      addressType: 'IPv4',
      ports: [
        { name: 'https', port: 443, protocol: 'TCP' },
        { name: 'http', port: 80, protocol: 'TCP' },
      ],
      endpoints: spec.targetAddresses.map((address) => ({
        addresses: [address],
        conditions: { ready: true },
      })),
    },
    {
      apiVersion: TRAEFIK,
      kind: 'IngressRouteTCP',
      metadata: metadata(`${name}-tls`),
      spec: {
        entryPoints: ['websecure'],
        routes: [
          {
            match: `HostSNI(\`${fqdn}\`)`,
            services: [{ name, port: 443 }],
          },
        ],
        tls: { passthrough: true },
      },
    },
    {
      apiVersion: TRAEFIK,
      kind: 'IngressRoute',
      metadata: metadata(`${name}-web`),
      spec: {
        entryPoints: ['web'],
        routes: [
          {
            match: host,
            kind: 'Rule',
            priority: BRIDGE_ROUTE_PRIORITY,
            services: [{ name, port: 80, passHostHeader: true }],
          },
        ],
      },
    },
  ];
}

/** Null when the PEM holds a certificate valid now for the name, else why not. */
export function certificateProblem(
  pem: string,
  fqdn: string,
  now: Date,
): string | null {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return `the secret for ${fqdn} is not a readable certificate`;
  }
  if (new Date(cert.validFrom) > now) {
    return `the certificate for ${fqdn} is not valid before ${cert.validFrom}`;
  }
  if (new Date(cert.validTo) <= now) {
    return `the certificate for ${fqdn} expired on ${cert.validTo}`;
  }
  if (!cert.checkHost(fqdn)) {
    return `the certificate in the secret does not cover ${fqdn}`;
  }
  return null;
}

/** A wildcard certificate opens every name under its domain: it never leaves its cluster. */
export function isWildcardCertificate(pem: string): boolean {
  try {
    const cert = new X509Certificate(pem);
    return (
      (cert.subjectAltName ?? '').includes('DNS:*.') ||
      cert.subject.includes('CN=*.')
    );
  } catch {
    return false;
  }
}

export function groupBridgeHosts(
  endpoints: Pick<AppEndpointEntity, 'id' | 'fqdn' | 'k8sNamespace'>[],
): { fqdn: string; namespace: string; endpointIds: string[] }[] {
  const hosts = new Map<
    string,
    { fqdn: string; namespace: string; endpointIds: string[] }
  >();
  for (const endpoint of endpoints) {
    const host = hosts.get(endpoint.fqdn);
    if (host) {
      host.endpointIds.push(endpoint.id);
    } else {
      hosts.set(endpoint.fqdn, {
        fqdn: endpoint.fqdn,
        namespace: endpoint.k8sNamespace,
        endpointIds: [endpoint.id],
      });
    }
  }
  return [...hosts.values()];
}

/** The first reason, readable by a person, why these endpoints cannot be bridged. */
export function staticBridgeBlocker(
  endpoints: Pick<
    AppEndpointEntity,
    | 'fqdn'
    | 'hostnameMode'
    | 'clusterDnsZoneId'
    | 'gatewayConfig'
    | 'sanCertificateId'
  >[],
): string | null {
  if (endpoints.length === 0) {
    return 'The application has no address to forward.';
  }
  for (const endpoint of endpoints) {
    if (endpoint.fqdn.startsWith('*.')) {
      return `${endpoint.fqdn} is a wildcard name; the bridge forwards exact names only.`;
    }
    if (endpoint.hostnameMode === HostnameMode.IP) {
      return `${endpoint.fqdn} is built from the source address and cannot move.`;
    }
    if (!endpoint.clusterDnsZoneId) {
      return `The DNS of ${endpoint.fqdn} is not managed by Flui, so Flui cannot switch it after the bridge opens.`;
    }
    if (endpoint.gatewayConfig?.allowIps?.length) {
      return `${endpoint.fqdn} has an IP allow-list; forwarded requests would reach the new cluster from the old cluster's address, so the list would refuse them.`;
    }
    if (endpoint.sanCertificateId) {
      return `${endpoint.fqdn} uses a shared certificate that is not moved with the application.`;
    }
  }
  return null;
}

export function ipv4Only(addresses: string[]): string[] {
  return addresses.filter((address) => isIP(address) === 4);
}

export function perHostSecretName(fqdn: string): string {
  return `tls-${fqdn.replaceAll('.', '-').replaceAll('*', 'wildcard')}`;
}

/** True when the ClusterIssuer is Ready and has a DNS-01 solver for the name. */
export function dns01IssuerServes(
  issuer: {
    status?: { conditions?: { type: string; status: string }[] };
    spec?: {
      acme?: {
        solvers?: { dns01?: unknown; selector?: { dnsZones?: string[] } }[];
      };
    };
  } | null,
  fqdn: string,
): boolean {
  const ready = (issuer?.status?.conditions ?? []).some(
    (c: { type: string; status: string }) =>
      c.type === 'Ready' && c.status === 'True',
  );
  const name = fqdn.toLowerCase();
  const solves = (issuer?.spec?.acme?.solvers ?? []).some(
    (s: { dns01?: unknown; selector?: { dnsZones?: string[] } }) =>
      s.dns01 &&
      (s.selector?.dnsZones ?? []).some(
        (zone) =>
          name === zone.toLowerCase() ||
          name.endsWith(`.${zone.toLowerCase()}`),
      ),
  );
  return ready && solves;
}

export function renderBridgeCertificateSecret(spec: {
  bridgeId: string;
  secretName: string;
  namespace: string;
  crt: string;
  key: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/tls',
    metadata: {
      name: spec.secretName,
      namespace: spec.namespace,
      labels: {
        'managed-by': FLUI_MANAGER,
        'flui-resource-type': 'migration-bridge-certificate',
        [BRIDGE_ID_LABEL]: spec.bridgeId,
      },
    },
    data: { 'tls.crt': spec.crt, 'tls.key': spec.key },
  };
}
