import { sanitizeApiServerFirewallRules } from './firewall-rules.template';
import { FirewallRule } from '../../../providers/interfaces/firewall-provider.interface';

describe('sanitizeApiServerFirewallRules', () => {
  const subnetCidr = '10.10.1.0/24';

  it('always guarantees the subnet CIDR on an inbound tcp/6443 rule, prepended', () => {
    const rules: FirewallRule[] = [
      {
        description: 'K3s API server',
        direction: 'in',
        protocol: 'tcp',
        port: '6443',
        sourceIps: ['0.0.0.0/0', '::/0'],
      },
    ];

    const [rule] = sanitizeApiServerFirewallRules(rules, subnetCidr);

    // Subnet is always present; the caller's explicit sources are preserved
    // (6443 is mTLS-protected — an open port grants nothing without the cert).
    expect(rule.sourceIps).toEqual([subnetCidr, '0.0.0.0/0', '::/0']);
  });

  it('preserves a caller-provided source IP on 6443 (e.g. cross-provider control/dev)', () => {
    const rules: FirewallRule[] = [
      {
        description: 'K3s API server',
        direction: 'in',
        protocol: 'tcp',
        port: '6443',
        sourceIps: ['203.0.113.7/32'],
      },
    ];

    const [rule] = sanitizeApiServerFirewallRules(rules, subnetCidr);

    expect(rule.sourceIps).toEqual([subnetCidr, '203.0.113.7/32']);
  });

  it('does not duplicate the subnet CIDR when the caller already listed it', () => {
    const rules: FirewallRule[] = [
      {
        description: 'K3s API server',
        direction: 'in',
        protocol: 'tcp',
        port: '6443',
        sourceIps: [subnetCidr],
      },
    ];

    const [rule] = sanitizeApiServerFirewallRules(rules, subnetCidr);

    expect(rule.sourceIps).toEqual([subnetCidr]);
  });

  it('leaves non-6443 inbound rules untouched', () => {
    const rules: FirewallRule[] = [
      {
        description: 'SSH',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['0.0.0.0/0'],
      },
      {
        description: 'HTTPS',
        direction: 'in',
        protocol: 'tcp',
        port: '443',
        sourceIps: ['0.0.0.0/0'],
      },
    ];

    expect(sanitizeApiServerFirewallRules(rules, subnetCidr)).toEqual(rules);
  });

  it('leaves outbound rules untouched', () => {
    const rules: FirewallRule[] = [
      {
        description: 'Outbound TCP',
        direction: 'out',
        protocol: 'tcp',
        destinationIps: ['0.0.0.0/0'],
      },
    ];

    expect(sanitizeApiServerFirewallRules(rules, subnetCidr)).toEqual(rules);
  });

  it('does not append a 6443 rule when none is present', () => {
    const rules: FirewallRule[] = [
      {
        description: 'SSH',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['0.0.0.0/0'],
      },
    ];

    expect(sanitizeApiServerFirewallRules(rules, subnetCidr)).toHaveLength(1);
  });
});
