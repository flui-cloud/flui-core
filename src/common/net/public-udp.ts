export interface AppUdpPort {
  name: string;
  port: number;
}

/** An internal TCP port an application serves beyond its main one. */
export interface AppServicePort {
  name: string;
  port: number;
}

export interface UdpRuleLike {
  direction: 'in' | 'out';
  protocol: 'tcp' | 'udp' | 'icmp';
  port?: string;
}

/**
 * The only ports an application may publish over UDP. Kept clear of the
 * management overlay and of the NodePort range, so an application can never
 * take a port the platform itself listens on, and the host firewall can close
 * the whole range by default.
 */
export const APP_UDP_PORT_MIN = 10000;
export const APP_UDP_PORT_MAX = 10999;
export const APP_UDP_PORT_RANGE = `${APP_UDP_PORT_MIN}-${APP_UDP_PORT_MAX}`;

/**
 * `pending`: the rule is saved but not yet applied. `unmanaged`: the cluster has
 * no firewall Flui manages, so the port is as reachable as the provider allows.
 * `not-published`: a trial app, which never gets a port on the node.
 */
export type UdpPortState =
  | 'open'
  | 'pending'
  | 'closed'
  | 'unmanaged'
  | 'not-published';

export interface UdpPortStatus extends AppUdpPort {
  state: UdpPortState;
}

export function isAppUdpPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= APP_UDP_PORT_MIN &&
    port <= APP_UDP_PORT_MAX
  );
}

function portBounds(port?: string): [number, number] | null {
  if (!port) return null;
  const match = /^(\d+)(?:-(\d+))?$/.exec(port.trim());
  if (!match) return null;
  const low = Number(match[1]);
  const high = match[2] ? Number(match[2]) : low;
  return low <= high ? [low, high] : null;
}

export function ruleOpensUdpPort(rule: UdpRuleLike, port: number): boolean {
  if (rule.direction !== 'in' || rule.protocol !== 'udp') return false;
  const bounds = portBounds(rule.port);
  return !!bounds && port >= bounds[0] && port <= bounds[1];
}

export function udpPortStates(
  ports: AppUdpPort[],
  firewall: { desired: UdpRuleLike[]; applied: UdpRuleLike[] | null } | null,
): UdpPortStatus[] {
  return ports.map((p) => {
    if (!firewall) return { ...p, state: 'unmanaged' };
    const opens = (rules: UdpRuleLike[]) =>
      rules.some((r) => ruleOpensUdpPort(r, p.port));
    if (!opens(firewall.desired)) return { ...p, state: 'closed' };
    return { ...p, state: opens(firewall.applied ?? []) ? 'open' : 'pending' };
  });
}

export const UDP_PORT_IN_USE = 'UDP_PORT_IN_USE';

/**
 * A host port is held by one pod per node, and the firewall rule that opens it
 * covers every node of the cluster: two applications asking for the same one
 * would either never start or answer for each other.
 */
export function udpPortClash(
  requested: AppUdpPort[],
  holders: Array<{ slug: string; udpPorts?: AppUdpPort[] | null }>,
): { port: number; holder: string } | null {
  const seen = new Set<number>();
  for (const { port } of requested) {
    if (seen.has(port)) return { port, holder: 'this app' };
    seen.add(port);
  }
  for (const holder of holders) {
    const taken = (holder.udpPorts ?? []).find((p) => seen.has(p.port));
    if (taken) return { port: taken.port, holder: holder.slug };
  }
  return null;
}

export function udpPortClashMessage(clash: {
  port: number;
  holder: string;
}): string {
  return clash.holder === 'this app'
    ? `UDP port ${clash.port} is declared twice in this app. Give each UDP port its own number.`
    : `UDP port ${clash.port} is already used by "${clash.holder}" on this cluster. Install on another cluster, or remove "${clash.holder}" first.`;
}
