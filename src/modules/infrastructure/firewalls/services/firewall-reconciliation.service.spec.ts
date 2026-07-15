import { BadRequestException } from '@nestjs/common';
import { FirewallReconciliationService } from './firewall-reconciliation.service';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';

/**
 * Focused unit tests for the host-firewall additions:
 *  - normalizeRulesForCapability (port-22 honesty for host-nftables)
 *  - ensureClusterFirewall (idempotent enable + capability-driven seed)
 *
 * The provider-apply path (reconcile) is stubbed — it is exercised by the
 * nftables-ruleset spec and the live BYOS validation.
 */
describe('FirewallReconciliationService — host firewall', () => {
  const makeCapabilities = (supportsSshAllowlist: boolean) => ({
    isProviderSupported: jest.fn().mockReturnValue(true),
    getCapabilitiesService: jest.fn().mockReturnValue({
      getStaticCapabilities: () => ({ firewall: { supportsSshAllowlist } }),
    }),
  });

  const sshRule: FirewallRuleDto = {
    description: 'SSH',
    direction: 'in',
    protocol: 'tcp',
    port: '22',
    sourceIps: ['203.0.113.0/24'],
  };
  const httpsRule: FirewallRuleDto = {
    description: 'HTTPS',
    direction: 'in',
    protocol: 'tcp',
    port: '443',
    sourceIps: ['10.0.0.0/8'],
  };

  // `find` backs resolveControlEgressIps: no control cluster => no SSH peer IPs
  // to merge, so these cases exercise the rules exactly as submitted.
  const build = (capabilities: any, overrides: any = {}) =>
    new FirewallReconciliationService(
      overrides.desiredState ?? ({} as any),
      overrides.providerFactory ?? ({} as any),
      capabilities as any,
      overrides.labelService ?? ({} as any),
      overrides.clusterRepo ??
        ({ find: jest.fn().mockResolvedValue([]) } as any),
    );

  describe('normalizeRulesForCapability', () => {
    it('widens inbound :22 to world-open when SSH allowlisting is unsupported (host-nftables)', () => {
      const svc = build(makeCapabilities(false));
      const out = svc.normalizeRulesForCapability('byos', [sshRule, httpsRule]);

      const ssh = out.find((r) => r.port === '22');
      expect(ssh?.sourceIps).toEqual(['0.0.0.0/0', '::/0']);
      // other rules untouched
      expect(out.find((r) => r.port === '443')?.sourceIps).toEqual([
        '10.0.0.0/8',
      ]);
    });

    it('leaves the :22 allowlist intact when allowlisting is supported (managed-edge)', () => {
      const svc = build(makeCapabilities(true));
      const out = svc.normalizeRulesForCapability('hetzner', [sshRule]);
      expect(out[0].sourceIps).toEqual(['203.0.113.0/24']);
    });

    it('fails open (no normalization) when the provider is unregistered', () => {
      const caps = {
        isProviderSupported: jest.fn().mockReturnValue(false),
        getCapabilitiesService: jest.fn(),
      };
      const svc = build(caps);
      const out = svc.normalizeRulesForCapability('unknown', [sshRule]);
      expect(out[0].sourceIps).toEqual(['203.0.113.0/24']);
      expect(caps.getCapabilitiesService).not.toHaveBeenCalled();
    });
  });

  describe('ensureClusterFirewall', () => {
    it('is idempotent: re-reconciles an existing firewall instead of creating a duplicate', async () => {
      const desiredState = {
        getFirewallByClusterId: jest.fn().mockResolvedValue({ id: 'fw-1' }),
        createFirewall: jest.fn(),
      };
      const svc = build(makeCapabilities(false), { desiredState });
      const reconcileSpy = jest
        .spyOn(svc, 'reconcile')
        .mockResolvedValue({ id: 'fw-1' } as any);

      const result = await svc.ensureClusterFirewall('cluster-1');

      expect(result).toEqual({ id: 'fw-1' });
      expect(reconcileSpy).toHaveBeenCalledWith('fw-1');
      expect(desiredState.createFirewall).not.toHaveBeenCalled();
    });

    it('seeds normalized default rules for a host-nftables cluster when none exists', async () => {
      const desiredState = {
        getFirewallByClusterId: jest.fn().mockRejectedValue(new Error('404')),
        createFirewall: jest.fn().mockResolvedValue({ id: 'fw-new' }),
      };
      const clusterRepo = {
        findOne: jest
          .fn()
          .mockResolvedValue({ provider: 'byos', clusterType: 'control' }),
        find: jest.fn().mockResolvedValue([]),
      };
      const svc = build(makeCapabilities(false), { desiredState, clusterRepo });
      jest.spyOn(svc, 'reconcile').mockResolvedValue({ id: 'fw-new' } as any);

      await svc.ensureClusterFirewall('cluster-1');

      expect(desiredState.createFirewall).toHaveBeenCalledTimes(1);
      const [clusterId, rules] = desiredState.createFirewall.mock.calls[0];
      expect(clusterId).toBe('cluster-1');
      const seededSsh = rules.find(
        (r: FirewallRuleDto) => r.port === '22' && r.direction === 'in',
      );
      // Default CONTROL rules already open :22 world-wide; normalization keeps it so.
      expect(seededSsh?.sourceIps).toEqual(['0.0.0.0/0', '::/0']);
    });

    it('throws when the cluster does not exist', async () => {
      const desiredState = {
        getFirewallByClusterId: jest.fn().mockRejectedValue(new Error('404')),
        createFirewall: jest.fn(),
      };
      const clusterRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
      };
      const svc = build(makeCapabilities(false), { desiredState, clusterRepo });

      await expect(svc.ensureClusterFirewall('missing')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

describe('FirewallReconciliationService.ensureWorkloadSshFromControl', () => {
  const ssh = (sourceIps: string[]): FirewallRuleDto => ({
    description: 'SSH Access',
    direction: 'in',
    protocol: 'tcp',
    port: '22',
    sourceIps,
  });
  const run = (rules: FirewallRuleDto[], ips: string[], type = 'workload') =>
    FirewallReconciliationService.ensureWorkloadSshFromControl(
      type as any,
      rules,
      ips,
    );

  it('adds the control plane while keeping the operator allowlisted', () => {
    const out = run([ssh(['203.0.113.9/32'])], ['198.51.100.7']);
    expect(out[0].sourceIps).toEqual(['203.0.113.9/32', '198.51.100.7/32']);
  });

  it('never widens to the world', () => {
    const out = run([ssh(['203.0.113.9/32'])], ['198.51.100.7']);
    expect(out[0].sourceIps).not.toContain('0.0.0.0/0');
  });

  it('leaves the control cluster alone — the CLI drives it from a known IP', () => {
    const rules = [ssh(['203.0.113.9/32'])];
    expect(run(rules, ['198.51.100.7'], 'control')).toEqual(rules);
  });

  it('is idempotent — a second pass adds nothing', () => {
    const once = run([ssh(['203.0.113.9/32'])], ['198.51.100.7']);
    expect(run(once, ['198.51.100.7'])).toEqual(once);
  });

  it('respects an explicit world-open :22 instead of appending to it', () => {
    const rules = [ssh(['0.0.0.0/0'])];
    expect(run(rules, ['198.51.100.7'])).toEqual(rules);
  });

  it('injects :22 when the caller omitted it entirely', () => {
    const out = run([], ['198.51.100.7']);
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe('22');
    expect(out[0].sourceIps).toEqual(['198.51.100.7/32']);
  });

  it('is a no-op when the control has no resolvable address', () => {
    const rules = [ssh(['203.0.113.9/32'])];
    expect(run(rules, [])).toEqual(rules);
  });

  it('allowlists every control node, since the API may egress from any of them', () => {
    const out = run(
      [ssh(['203.0.113.9/32'])],
      ['198.51.100.7', '198.51.100.8'],
    );
    expect(out[0].sourceIps).toEqual([
      '203.0.113.9/32',
      '198.51.100.7/32',
      '198.51.100.8/32',
    ]);
  });
});

describe('FirewallReconciliationService.ensureRequiredIngress', () => {
  const inbound = (port: string): FirewallRuleDto => ({
    description: `port ${port}`,
    direction: 'in',
    protocol: 'tcp',
    port,
    sourceIps: ['0.0.0.0/0', '::/0'],
  });
  const outbound: FirewallRuleDto = {
    description: 'egress',
    direction: 'out',
    protocol: 'tcp',
    destinationIps: ['0.0.0.0/0', '::/0'],
  };
  const inboundTcpPorts = (rules: FirewallRuleDto[]) =>
    new Set(
      rules
        .filter((r) => r.direction === 'in' && r.protocol === 'tcp')
        .map((r) => r.port),
    );

  it('leaves rules untouched when both 80 and 443 inbound are present', () => {
    const rules = [inbound('22'), inbound('80'), inbound('443'), outbound];
    expect(FirewallReconciliationService.ensureRequiredIngress(rules)).toEqual(
      rules,
    );
  });

  it('does not re-inject a source-allowlisted required port (kept as-is)', () => {
    const rules = [
      { ...inbound('80'), sourceIps: ['203.0.113.0/24'] },
      { ...inbound('443'), sourceIps: ['203.0.113.0/24'] },
    ];
    const out = FirewallReconciliationService.ensureRequiredIngress(rules);
    expect(out).toEqual(rules);
  });

  it('injects 443 when missing (would otherwise lock out the dashboard/API)', () => {
    const out = FirewallReconciliationService.ensureRequiredIngress([
      inbound('80'),
    ]);
    expect(inboundTcpPorts(out)).toEqual(new Set(['80', '443']));
    const injected = out.find((r) => r.port === '443');
    expect(injected?.sourceIps).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('injects both 80 and 443 when neither is present', () => {
    const out = FirewallReconciliationService.ensureRequiredIngress([
      inbound('22'),
    ]);
    expect(inboundTcpPorts(out)).toEqual(new Set(['22', '80', '443']));
  });

  it('does not add any outbound/egress rule', () => {
    const out = FirewallReconciliationService.ensureRequiredIngress([
      inbound('80'),
      inbound('443'),
    ]);
    expect(out.some((r) => r.direction === 'out')).toBe(false);
  });
});
