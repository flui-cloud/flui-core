import {
  renderFluiNftRuleset,
  encodeRulesComment,
  decodeRulesComment,
} from './nftables-ruleset';
import { FirewallRule } from '../../interfaces/firewall-provider.interface';

const HOST_OPTS = { supportsSshAllowlist: false };

describe('renderFluiNftRuleset', () => {
  it('produces a default-drop input chain with the load-bearing k3s allowances', () => {
    const out = renderFluiNftRuleset([], HOST_OPTS);
    expect(out).toContain('table inet flui {');
    expect(out).toContain('type filter hook input priority 0; policy drop;');
    expect(out).toContain('iif "lo" accept');
    expect(out).toContain('ct state established,related accept');
    expect(out).toContain('ct state invalid drop');
    // k3s pod + service CIDRs and overlay/kubelet ports must always be allowed.
    expect(out).toContain('ip saddr 10.42.0.0/16 accept');
    expect(out).toContain('ip saddr 10.43.0.0/16 accept');
    expect(out).toContain('udp dport 8472 accept');
    expect(out).toContain('tcp dport 10250 accept');
    // forward + output never default-drop.
    expect(out).toContain('hook forward priority 0; policy accept;');
    expect(out).toContain('hook output priority 0; policy accept;');
  });

  it('always keeps SSH open via the anti-lockout rule', () => {
    const out = renderFluiNftRuleset([], HOST_OPTS);
    expect(out).toContain('tcp dport 22 accept comment "ssh anti-lockout"');
  });

  it('uses the atomic add/delete/define idiom so re-apply never errors', () => {
    const out = renderFluiNftRuleset([], HOST_OPTS);
    const addIdx = out.indexOf('\ntable inet flui\n');
    const delIdx = out.indexOf('\ndelete table inet flui\n');
    const defIdx = out.indexOf('table inet flui {');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(addIdx);
    expect(defIdx).toBeGreaterThan(delIdx);
  });

  it('renders inbound tcp on 80/443 from anywhere without a saddr match', () => {
    const rules: FirewallRule[] = [
      {
        description: 'HTTP Ingress (Traefik)',
        direction: 'in',
        protocol: 'tcp',
        port: '80',
        sourceIps: ['0.0.0.0/0', '::/0'],
      },
      {
        description: 'HTTPS Ingress (Traefik)',
        direction: 'in',
        protocol: 'tcp',
        port: '443',
        sourceIps: ['0.0.0.0/0', '::/0'],
      },
    ];
    const out = renderFluiNftRuleset(rules, HOST_OPTS);
    expect(out).toContain(
      'tcp dport 80 accept comment "HTTP Ingress (Traefik)"',
    );
    expect(out).toContain(
      'tcp dport 443 accept comment "HTTPS Ingress (Traefik)"',
    );
    expect(out).not.toMatch(/ip6? saddr .* dport 80/);
  });

  it('splits a specific source allowlist into ipv4 and ipv6 sets', () => {
    const rules: FirewallRule[] = [
      {
        description: 'Admin API',
        direction: 'in',
        protocol: 'tcp',
        port: '8443',
        sourceIps: ['203.0.113.0/24', '2001:db8::/32'],
      },
    ];
    const out = renderFluiNftRuleset(rules, HOST_OPTS);
    expect(out).toContain(
      'ip saddr { 203.0.113.0/24 } tcp dport 8443 accept comment "Admin API"',
    );
    expect(out).toContain(
      'ip6 saddr { 2001:db8::/32 } tcp dport 8443 accept comment "Admin API"',
    );
  });

  it('renders a udp port range', () => {
    const rules: FirewallRule[] = [
      {
        description: 'Game servers',
        direction: 'in',
        protocol: 'udp',
        port: '7000-7100',
        sourceIps: ['0.0.0.0/0'],
      },
    ];
    const out = renderFluiNftRuleset(rules, HOST_OPTS);
    expect(out).toContain('udp dport 7000-7100 accept');
  });

  it('ignores any inbound :22 rule when allowlisting is unsupported (host firewall)', () => {
    const rules: FirewallRule[] = [
      {
        description: 'SSH from office only',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['198.51.100.10/32'],
      },
    ];
    const out = renderFluiNftRuleset(rules, HOST_OPTS);
    // Only the anti-lockout 22 line — never a source-restricted 22 rule.
    expect(out).not.toContain('198.51.100.10/32');
    expect(out.match(/dport 22/g)?.length).toBe(1);
  });

  it('honours a :22 allowlist when the provider supports it (managed edge)', () => {
    const rules: FirewallRule[] = [
      {
        description: 'SSH from office only',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['198.51.100.10/32'],
      },
    ];
    const out = renderFluiNftRuleset(rules, { supportsSshAllowlist: true });
    expect(out).toContain('ip saddr { 198.51.100.10/32 } tcp dport 22 accept');
  });

  it('does not render outbound rules (output stays default-accept)', () => {
    const rules: FirewallRule[] = [
      {
        description: 'Allow all outbound TCP traffic',
        direction: 'out',
        protocol: 'tcp',
        destinationIps: ['0.0.0.0/0', '::/0'],
      },
    ];
    const out = renderFluiNftRuleset(rules, HOST_OPTS);
    expect(out).not.toContain('daddr');
    expect(out).toContain('hook output priority 0; policy accept;');
  });

  it('sanitizes rule descriptions used as nft comments', () => {
    const rules: FirewallRule[] = [
      {
        description: 'weird"\nname',
        direction: 'in',
        protocol: 'tcp',
        port: '9000',
        sourceIps: ['0.0.0.0/0'],
      },
    ];
    const out = renderFluiNftRuleset(rules, HOST_OPTS);
    expect(out).not.toContain('weird"');
    expect(out).toContain('comment "weird  name"');
  });
});

describe('rules comment round-trip', () => {
  it('encodes and decodes the canonical rule set', () => {
    const rules: FirewallRule[] = [
      {
        description: 'HTTPS',
        direction: 'in',
        protocol: 'tcp',
        port: '443',
        sourceIps: ['0.0.0.0/0'],
      },
    ];
    const comment = encodeRulesComment(rules);
    expect(comment.startsWith('# flui-rules-b64:')).toBe(true);
    const decoded = decodeRulesComment(`foo\n${comment}\nbar`);
    expect(decoded).toEqual(rules);
  });

  it('decodes the comment embedded in a full rendered ruleset', () => {
    const rules: FirewallRule[] = [
      {
        description: 'HTTP',
        direction: 'in',
        protocol: 'tcp',
        port: '80',
        sourceIps: ['0.0.0.0/0'],
      },
    ];
    const out = renderFluiNftRuleset(rules, HOST_OPTS);
    expect(decodeRulesComment(out)).toEqual(rules);
  });

  it('returns null when no comment is present', () => {
    expect(decodeRulesComment('table inet flui {}')).toBeNull();
  });
});
