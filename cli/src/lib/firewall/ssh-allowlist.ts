import type { FirewallRule } from '../../../../src/modules/providers/interfaces/firewall-provider.interface';
import { CONTROL_FIREWALL_RULES } from '../templates/firewall-rules';

export type AllowlistChange = 'replace' | 'add' | 'remove';

export const isSshRule = (r: FirewallRule): boolean =>
  r.direction === 'in' && r.protocol === 'tcp' && r.port === '22';

export function sshSourcesOf(rules: FirewallRule[] | undefined): string[] {
  return (rules ?? []).find(isSshRule)?.sourceIps ?? [];
}

/** Replace the SSH rule's source IPs in place; add one if absent (other rules untouched). */
export function withSshSource(
  baseRules: FirewallRule[],
  sshCidrs: string[],
): FirewallRule[] {
  const rules = baseRules.length ? baseRules : CONTROL_FIREWALL_RULES(sshCidrs);
  if (!rules.some(isSshRule)) {
    return [
      {
        description: 'SSH access for server management',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: sshCidrs,
      },
      ...rules,
    ];
  }
  return rules.map((r) => (isSshRule(r) ? { ...r, sourceIps: sshCidrs } : r));
}

/**
 * The SSH sources after a change, starting from everything that admits
 * someone today: the rules Flui keeps and the ones live on the provider. A
 * source present on only one side is kept rather than dropped in silence —
 * it is usually the address somebody is working from right now.
 */
export function nextSshSources(
  saved: string[],
  live: string[],
  requested: string[],
  change: AllowlistChange,
): { current: string[]; next: string[] } {
  const current = [...new Set([...saved, ...live])];
  if (change === 'add') {
    return { current, next: [...new Set([...current, ...requested])] };
  }
  if (change === 'remove') {
    return { current, next: current.filter((c) => !requested.includes(c)) };
  }
  return { current, next: [...new Set(requested)] };
}
