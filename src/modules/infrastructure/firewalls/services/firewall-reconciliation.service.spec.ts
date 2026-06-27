import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
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

  const build = (capabilities: any, overrides: any = {}) =>
    new FirewallReconciliationService(
      overrides.desiredState ?? ({} as any),
      overrides.providerFactory ?? ({} as any),
      capabilities as any,
      overrides.labelService ?? ({} as any),
      overrides.clusterRepo ?? ({} as any),
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
      const clusterRepo = { findOne: jest.fn().mockResolvedValue(null) };
      const svc = build(makeCapabilities(false), { desiredState, clusterRepo });

      await expect(svc.ensureClusterFirewall('missing')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

describe('FirewallReconciliationService.assertRequiredIngress', () => {
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

  it('passes when both 80 and 443 inbound are present', () => {
    expect(() =>
      FirewallReconciliationService.assertRequiredIngress([
        inbound('22'),
        inbound('80'),
        inbound('443'),
        outbound,
      ]),
    ).not.toThrow();
  });

  it('allows the required ports to be source-allowlisted (still present)', () => {
    expect(() =>
      FirewallReconciliationService.assertRequiredIngress([
        { ...inbound('80'), sourceIps: ['203.0.113.0/24'] },
        { ...inbound('443'), sourceIps: ['203.0.113.0/24'] },
      ]),
    ).not.toThrow();
  });

  it('rejects removing 443 (would lock out the dashboard/API)', () => {
    expect(() =>
      FirewallReconciliationService.assertRequiredIngress([inbound('80')]),
    ).toThrow(UnprocessableEntityException);
  });

  it('rejects removing both 80 and 443, naming both', () => {
    try {
      FirewallReconciliationService.assertRequiredIngress([inbound('22')]);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as Error).message).toContain('443');
      expect((e as Error).message).toContain('80');
    }
  });

  it('does not require any outbound/egress rule', () => {
    expect(() =>
      FirewallReconciliationService.assertRequiredIngress([
        inbound('80'),
        inbound('443'),
      ]),
    ).not.toThrow();
  });
});
