import { FirewallRuleDto } from '../../providers/dto/firewall.dto';
import { TopologyInboundRuleDto } from '../dto/topology.dto';

const ANYWHERE = new Set(['0.0.0.0/0', '::/0']);

/**
 * What a cluster's Flui firewall lets in, without the address ranges: the map
 * says how open a port is, the firewall page says to whom.
 */
export function inboundOf(
  firewall:
    | {
        lastAppliedRules?: FirewallRuleDto[] | null;
        desiredRules?: FirewallRuleDto[] | null;
      }
    | undefined,
): TopologyInboundRuleDto[] | null {
  if (!firewall) return null;
  const rules = firewall.lastAppliedRules?.length
    ? firewall.lastAppliedRules
    : (firewall.desiredRules ?? []);
  return rules
    .filter((r) => r.direction === 'in')
    .map((r) => {
      const sources = r.sourceIps ?? [];
      return {
        protocol: r.protocol,
        port: r.protocol === 'icmp' ? null : (r.port ?? null),
        description: r.description,
        fromAnywhere: sources.some((s) => ANYWHERE.has(s)),
        sourceCount: sources.length,
      };
    })
    .sort((a, b) => portOrder(a.port) - portOrder(b.port));
}

function portOrder(port: string | null): number {
  return port === null
    ? Number.MAX_SAFE_INTEGER
    : Number.parseInt(port, 10) || 0;
}
