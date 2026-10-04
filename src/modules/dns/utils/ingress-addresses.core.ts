/** What Kubernetes says about one node, for deciding where traffic may enter. */
export interface IngressNodeState {
  name: string;
  ready: boolean;
  /** A ready ingress proxy pod runs on this node and listens on 80/443. */
  servesIngress: boolean;
  externalIps: string[];
}

/** What Flui recorded about the same node when it created or joined it. */
export interface RecordedNode {
  serverName: string;
  ipAddress?: string | null;
}

const PRIVATE_V4: Array<[number, number]> = [
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0x00000000, 8],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** An IPv4 address a visitor on the internet can reach. */
export function isPublicIpv4(ip: string | null | undefined): ip is string {
  if (!ip) return false;
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return !PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === base;
  });
}

/**
 * The public addresses of every node that can take traffic right now: ready,
 * running the ingress proxy, and reachable from the internet. Sorted, so the
 * same cluster always produces the same answer and a record is rewritten only
 * when the set really changed.
 *
 * Kubernetes' own external address wins; otherwise the address Flui recorded
 * for the node, which for a node without a public address can be a private
 * one — that is filtered out rather than published.
 */
export function ingressAddresses(
  nodes: IngressNodeState[],
  recorded: RecordedNode[],
): string[] {
  const byName = new Map(recorded.map((r) => [r.serverName, r.ipAddress]));
  const addresses = new Set<string>();
  for (const node of nodes) {
    if (!node.ready || !node.servesIngress) continue;
    const address =
      node.externalIps.find((ip) => isPublicIpv4(ip)) ??
      (isPublicIpv4(byName.get(node.name)) ? byName.get(node.name) : null);
    if (address) addresses.add(address);
  }
  return [...addresses].sort((a, b) => a.localeCompare(b));
}

/** Seconds a resolver may keep a multi-node answer: short, so a failed node drops out quickly. */
export const MULTI_NODE_RECORD_TTL = 60;

/** What the ingress reconciler last measured, kept on `cluster.metadata`. */
export interface RecordedIngressAddresses {
  addresses: string[];
  measuredAt: string;
}

/**
 * The addresses a cluster's names point at: the last measured set of nodes
 * that take traffic, or the master alone until one has been measured. Every
 * writer of a cluster's A records reads this one answer, so a deploy, the
 * cluster wildcard and the replica reconcile never disagree.
 */
export function clusterIngressValues(cluster: {
  masterIpAddress?: string | null;
  metadata?: Record<string, unknown> | null;
}): string[] {
  const recorded = cluster.metadata?.ingressAddresses as
    | RecordedIngressAddresses
    | undefined;
  if (recorded?.addresses?.length) return [...recorded.addresses];
  return cluster.masterIpAddress ? [cluster.masterIpAddress] : [];
}

/** The zone's TTL, shortened to {@link MULTI_NODE_RECORD_TTL} when a name points at more than one node. */
export function ingressRecordTtl(zoneTtl: number, valueCount: number): number {
  return valueCount > 1 ? Math.min(zoneTtl, MULTI_NODE_RECORD_TTL) : zoneTtl;
}

export function sameValues(a: string[], b: string[]): boolean {
  const left = [...new Set(a)].sort((x, y) => x.localeCompare(y));
  const right = [...new Set(b)].sort((x, y) => x.localeCompare(y));
  return left.length === right.length && left.every((v, i) => v === right[i]);
}
