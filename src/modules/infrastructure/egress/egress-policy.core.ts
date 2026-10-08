import { CLUSTER_RESERVED_CIDRS } from '../networking/wireguard-address-pool';

export const EGRESS_PROTOCOLS = ['TCP', 'UDP'] as const;
export type EgressProtocol = (typeof EGRESS_PROTOCOLS)[number];

export interface EgressPort {
  port: number;
  protocol: EgressProtocol;
}

/**
 * Which ports the applications on a cluster may reach outside it. Null on the
 * cluster means open, which is every installation until an administrator
 * decides otherwise.
 */
export interface EgressPolicy {
  ports: EgressPort[];
}

export const EGRESS_POLICY_NAME = 'flui-egress';
export const SANDBOX_LABEL = 'flui.cloud/sandbox';

/** Platform namespaces carry this label from the installer and are never fenced. */
export function isSystemNamespace(
  labels: Record<string, string> | undefined,
): boolean {
  return labels?.['flui.cloud/scope'] === 'system';
}

const PRIVATE_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '127.0.0.0/8',
];

/** `80, 443, 53/udp` → ports; TCP unless a protocol is written after a slash. */
export function parseEgressPorts(spec: string): EgressPort[] {
  const ports: EgressPort[] = [];
  for (const raw of spec.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [num, proto = 'tcp'] = entry.split('/');
    const port = Number(num);
    const protocol = proto.trim().toUpperCase();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`"${entry}" is not a port between 1 and 65535`);
    }
    if (!(EGRESS_PROTOCOLS as readonly string[]).includes(protocol)) {
      throw new Error(`"${entry}": the protocol must be tcp or udp`);
    }
    ports.push({ port, protocol: protocol as EgressProtocol });
  }
  return normalizeEgressPorts(ports);
}

export function normalizeEgressPorts(ports: EgressPort[]): EgressPort[] {
  const seen = new Map<string, EgressPort>();
  for (const p of ports) seen.set(`${p.port}/${p.protocol}`, p);
  return [...seen.values()].sort(
    (a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol),
  );
}

export function formatEgressPorts(ports: EgressPort[]): string {
  return ports
    .map((p) => (p.protocol === 'TCP' ? `${p.port}` : `${p.port}/udp`))
    .join(', ');
}

/** What a person or an agent is told about the rule their applications live under. */
export function describeEgress(policy: EgressPolicy | null): string {
  if (!policy) return 'Outbound traffic is open on every port.';
  if (policy.ports.length === 0) {
    return 'Outbound traffic leaving the cluster is closed on every port; ask your administrator to open one.';
  }
  return `Outbound traffic leaving the cluster is allowed on ports ${formatEgressPorts(policy.ports)}; for any other port ask your administrator.`;
}

/**
 * The traffic that never counts as leaving: the cluster's pods and services,
 * and the private network between its nodes.
 */
export function clusterInternalCidrs(nodeNetwork?: string | null): string[] {
  return [...CLUSTER_RESERVED_CIDRS, ...(nodeNetwork ? [nodeNetwork] : [])];
}

function portLines(ports: EgressPort[]): string {
  return ports
    .map((p) => `        - protocol: ${p.protocol}\n          port: ${p.port}`)
    .join('\n');
}

/**
 * Egress only, never Ingress: a policy that names Ingress closes whatever it
 * does not list, and would cut off every application on the namespace.
 *
 * Two shapes. In a guest area the isolation policy already keeps traffic
 * inside the area, so this one only opens the internet, private ranges
 * excepted. Anywhere else the namespace has no other policy, so this one must
 * also keep the cluster's own traffic flowing, and returns null when the rule
 * is open: no policy at all is what open has always meant.
 */
export function buildEgressNetworkPolicy(
  namespace: string,
  policy: EgressPolicy | null,
  options: { isolated: boolean; internalCidrs: string[] },
): string | null {
  if (!policy && !options.isolated) return null;

  const excepted = PRIVATE_RANGES.map((r) => '              - ' + r).join('\n');
  const internet = options.isolated
    ? `    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
${excepted}`
    : `    - to:
        - ipBlock:
            cidr: 0.0.0.0/0`;

  const rules: string[] = [];
  if (!options.isolated) {
    rules.push(
      `    - to:\n${options.internalCidrs
        .map((cidr) => `        - ipBlock:\n            cidr: ${cidr}`)
        .join('\n')}`,
    );
  }
  if (!policy) {
    rules.push(internet);
  } else if (policy.ports.length > 0) {
    rules.push(`${internet}\n      ports:\n${portLines(policy.ports)}`);
  }

  return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${EGRESS_POLICY_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: flui
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:${rules.length ? `\n${rules.join('\n')}` : ' []'}
`;
}
