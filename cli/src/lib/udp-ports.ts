export type UdpPortState =
  | 'open'
  | 'pending'
  | 'closed'
  | 'unmanaged'
  | 'not-published';

export interface UdpPortView {
  name: string;
  port: number;
  state: UdpPortState;
  takenBy?: string | null;
}

export interface UdpPortsView {
  clusterId: string;
  firewallId: string | null;
  ports: UdpPortView[];
}

const STATE_TEXT: Record<UdpPortState, string> = {
  open: 'open',
  pending: 'rule saved, not applied yet',
  closed: 'closed',
  unmanaged: 'not filtered by Flui',
  'not-published': 'not available in the trial',
};

export function udpPortLine(p: UdpPortView): string {
  const held = p.takenBy ? `, already used by ${p.takenBy}` : '';
  return `UDP ${p.port} (${p.name})  ${STATE_TEXT[p.state]}${held}`;
}

/** What the person has to do next, or nothing when every port is open. */
export function udpPortsHint(view: UdpPortsView): string | null {
  const states = new Set(view.ports.map((p) => p.state));
  if (states.has('closed')) {
    return 'Flui never opens a UDP port on its own. Someone who manages the cluster adds an inbound UDP rule for it in the dashboard, under Cluster Firewalls.';
  }
  if (states.has('unmanaged')) {
    return 'This cluster has no firewall managed by Flui: the port is as reachable as your provider allows.';
  }
  if (states.has('pending')) {
    return 'The firewall rule is saved and is being applied.';
  }
  return null;
}
