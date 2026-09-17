export interface IFirewallProvider {
  createFirewall(config: CreateFirewallConfig): Promise<FirewallCreationResult>;
  getFirewall(firewallId: string): Promise<FirewallDetails | null>;
  listFirewalls(filters?: FirewallFilters): Promise<FirewallDetails[]>;
  updateFirewallRules(firewallId: string, rules: FirewallRule[]): Promise<void>;
  deleteFirewall(firewallId: string): Promise<void>;
  applyToServers(firewallId: string, serverIds: string[]): Promise<void>;
  removeFromServers(firewallId: string, serverIds: string[]): Promise<void>;

  /**
   * A fingerprint of everything this provider would actually send for these
   * rules, beyond the rules themselves.
   *
   * Reconciliation skips work when the desired rules have not changed, which is
   * right until what a provider *does* with those rules changes instead — a
   * host ruleset gains a line no rule names, a transform starts emitting a
   * different shape. Then nothing moves, nothing is re-applied, and the
   * improvement reaches only clusters created afterwards.
   *
   * Optional: a provider that does not implement it keeps the old behaviour of
   * comparing rules alone, which is safe and merely less thorough.
   */
  payloadFingerprint?(
    firewallId: string,
    rules: FirewallRule[],
  ): Promise<string | undefined>;
}

export interface FirewallRule {
  id?: string; // Optional unique identifier for rule (kebab-case format)
  description: string;
  direction: 'in' | 'out';
  protocol: 'tcp' | 'udp' | 'icmp';
  port?: string;
  sourceIps?: string[]; // Array di CIDR per direction 'in'
  destinationIps?: string[]; // Array di CIDR per direction 'out'
}

export interface CreateFirewallConfig {
  name: string;
  labels: Array<{ key: string; value: string }>;
  rules: FirewallRule[];
  applyToServerIds?: string[];
  applyToLabelSelector?: string;
}

export interface FirewallCreationResult {
  firewallId: string;
  appliedToServerIds?: string[];
}

export interface FirewallDetails {
  id: string;
  name: string;
  rules: FirewallRule[];
  labels: Record<string, string>;
  appliedTo: Array<{ serverId: string; serverName?: string }>;
}

export interface FirewallFilters {
  clusterId?: string;
  name?: string;
  labelSelector?: string;
}
