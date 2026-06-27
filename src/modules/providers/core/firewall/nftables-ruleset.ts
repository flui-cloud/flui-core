import { FirewallRule } from '../../interfaces/firewall-provider.interface';

export interface NftRenderOptions {
  supportsSshAllowlist: boolean;
  internalCidrs?: string[];
}

export const DEFAULT_INTERNAL_CIDRS = ['10.42.0.0/16', '10.43.0.0/16'];

const PORT_RE = /^\d{1,5}(-\d{1,5})?$/;
const IPV4_CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IPV6_CIDR_RE = /^[0-9a-fA-F:]+\/\d{1,3}$/;
const ANYWHERE = new Set(['0.0.0.0/0', '::/0']);

const COMMENT_PREFIX = '# flui-rules-b64:';

export function encodeRulesComment(rules: FirewallRule[]): string {
  const json = JSON.stringify(rules);
  return COMMENT_PREFIX + Buffer.from(json, 'utf-8').toString('base64');
}

export function decodeRulesComment(rulesetText: string): FirewallRule[] | null {
  const line = rulesetText
    .split('\n')
    .find((l) => l.startsWith(COMMENT_PREFIX));
  if (!line) return null;
  try {
    const b64 = line.slice(COMMENT_PREFIX.length).trim();
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as FirewallRule[]) : null;
  } catch {
    return null;
  }
}

function sanitizeComment(text: string): string {
  return text
    .replaceAll(/["\\\n\r]/g, ' ')
    .slice(0, 120)
    .trim();
}

function classifySources(sourceIps?: string[]): {
  anywhere: boolean;
  v4: string[];
  v6: string[];
} {
  if (!sourceIps || sourceIps.length === 0) {
    return { anywhere: true, v4: [], v6: [] };
  }
  if (sourceIps.some((ip) => ANYWHERE.has(ip))) {
    return { anywhere: true, v4: [], v6: [] };
  }
  const v4 = sourceIps.filter((ip) => IPV4_CIDR_RE.test(ip));
  const v6 = sourceIps.filter((ip) => IPV6_CIDR_RE.test(ip));
  return { anywhere: false, v4, v6 };
}

function renderInboundRule(rule: FirewallRule): string[] {
  const proto = rule.protocol;
  if (proto === 'icmp') {
    return [];
  }
  const port = rule.port?.trim();
  if (!port || !PORT_RE.test(port)) return [];

  if (port === '22') return [];

  const comment = rule.description
    ? ` comment "${sanitizeComment(rule.description)}"`
    : '';
  const { anywhere, v4, v6 } = classifySources(rule.sourceIps);

  if (anywhere) {
    return [`\t\t${proto} dport ${port} accept${comment}`];
  }

  const lines: string[] = [];
  if (v4.length > 0) {
    lines.push(
      `\t\tip saddr { ${v4.join(', ')} } ${proto} dport ${port} accept${comment}`,
    );
  }
  if (v6.length > 0) {
    lines.push(
      `\t\tip6 saddr { ${v6.join(', ')} } ${proto} dport ${port} accept${comment}`,
    );
  }
  return lines;
}

export function renderFluiNftRuleset(
  rules: FirewallRule[],
  options: NftRenderOptions,
): string {
  const internal = options.internalCidrs?.length
    ? options.internalCidrs
    : DEFAULT_INTERNAL_CIDRS;
  const internalV4 = internal.filter((c) => IPV4_CIDR_RE.test(c));
  const internalV6 = internal.filter((c) => IPV6_CIDR_RE.test(c));

  const inbound = rules
    .filter((r) => r.direction === 'in')
    .flatMap((r) =>
      options.supportsSshAllowlist
        ? renderInboundRuleHonouringSsh(r)
        : renderInboundRule(r),
    );

  const internalLines: string[] = [];
  for (const cidr of internalV4) {
    internalLines.push(`\t\tip saddr ${cidr} accept`);
  }
  for (const cidr of internalV6) {
    internalLines.push(`\t\tip6 saddr ${cidr} accept`);
  }

  const body = [
    '#!/usr/sbin/nft -f',
    '# Flui-managed host firewall — DO NOT EDIT (reconciled by Flui over SSH).',
    encodeRulesComment(rules),
    '',
    'table inet flui',
    'delete table inet flui',
    '',
    'table inet flui {',
    '\tchain input {',
    '\t\ttype filter hook input priority 0; policy drop;',
    '',
    '\t\tiif "lo" accept',
    '\t\tct state established,related accept',
    '\t\tct state invalid drop',
    '',
    '\t\t# Anti-lockout: SSH stays reachable (no out-of-band recovery on a host firewall).',
    '\t\ttcp dport 22 accept comment "ssh anti-lockout"',
    '',
    '\t\t# Liveness: ICMP / ICMPv6 (ping, path-MTU discovery).',
    '\t\tip protocol icmp accept',
    '\t\tip6 nexthdr ipv6-icmp accept',
    '',
    '\t\t# Intra-cluster k3s traffic — never fence the node off from its own CNI.',
    ...internalLines,
    '\t\tudp dport 8472 accept comment "flannel vxlan"',
    '\t\ttcp dport 10250 accept comment "kubelet"',
    '',
    '\t\t# Reconciled public ingress rules:',
    ...(inbound.length ? inbound : ['\t\t# (none)']),
    '\t}',
    '',
    '\tchain forward {',
    '\t\t# k3s relies on forwarding (pod/service routing); never default-drop here.',
    '\t\ttype filter hook forward priority 0; policy accept;',
    '\t}',
    '',
    '\tchain output {',
    '\t\ttype filter hook output priority 0; policy accept;',
    '\t}',
    '}',
    '',
  ];

  return body.join('\n');
}

function renderInboundRuleHonouringSsh(rule: FirewallRule): string[] {
  const proto = rule.protocol;
  if (proto === 'icmp') return [];
  const port = rule.port?.trim();
  if (!port || !PORT_RE.test(port)) return [];
  const comment = rule.description
    ? ` comment "${sanitizeComment(rule.description)}"`
    : '';
  const { anywhere, v4, v6 } = classifySources(rule.sourceIps);
  if (anywhere) return [`\t\t${proto} dport ${port} accept${comment}`];
  const lines: string[] = [];
  if (v4.length > 0)
    lines.push(
      `\t\tip saddr { ${v4.join(', ')} } ${proto} dport ${port} accept${comment}`,
    );
  if (v6.length > 0)
    lines.push(
      `\t\tip6 saddr { ${v6.join(', ')} } ${proto} dport ${port} accept${comment}`,
    );
  return lines;
}
