import { BadRequestException } from '@nestjs/common';
import {
  HostFirewallLayerService,
  HostLayerRecord,
  describeHostLayer,
} from './host-firewall-layer.service';
import { FirewallReconciliationService } from './firewall-reconciliation.service';
import { HostLayerBlockedError } from '../../../providers/core/firewall/nftables-firewall.backend';
import { HostFirewallLayerState } from '../dto/cluster-firewall.dto';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';

const rules: FirewallRuleDto[] = [
  {
    description: 'HTTPS',
    direction: 'in',
    protocol: 'tcp',
    port: '443',
    sourceIps: ['0.0.0.0/0'],
  },
];

const capabilities = (backend: string) => ({
  getCapabilitiesService: jest.fn().mockReturnValue({
    getStaticCapabilities: () => ({ firewall: { backend } }),
  }),
});

const firewallOf = (
  hostLayer?: HostLayerRecord,
  cluster: Record<string, unknown> = {},
) =>
  ({
    id: 'fw1',
    clusterId: 'wc1',
    desiredRules: rules,
    metadata: hostLayer ? { hostLayer } : {},
    cluster: {
      id: 'wc1',
      provider: 'hetzner',
      clusterType: 'workload',
      status: 'ready',
      ...cluster,
    },
  }) as any;

const setup = (
  opts: {
    backend?: string;
    firewall?: any;
    nft?: Partial<Record<string, jest.Mock>>;
  } = {},
) => {
  let stored = opts.firewall ?? firewallOf({ enabled: true });
  const desiredState = {
    getFirewallByClusterId: jest.fn(async () => stored),
    getFirewallById: jest.fn(async () => stored),
    rememberHostLayer: jest.fn(async (_id: string, patch: object) => {
      stored = {
        ...stored,
        metadata: {
          ...stored.metadata,
          hostLayer: {
            enabled: false,
            ...stored.metadata?.hostLayer,
            ...patch,
          },
        },
      };
      return stored;
    }),
  };
  const nft = {
    hostLayerFingerprint: jest.fn().mockResolvedValue('fp-1'),
    applyHostLayer: jest.fn().mockResolvedValue(2),
    removeHostLayer: jest.fn().mockResolvedValue(undefined),
    ...opts.nft,
  };
  const service = new HostFirewallLayerService(
    desiredState as any,
    capabilities(opts.backend ?? 'managed-api') as any,
    nft as any,
  );
  return { service, desiredState, nft, current: () => stored };
};

const record = (fw: any): HostLayerRecord => fw.metadata.hostLayer;

describe('HostFirewallLayerService', () => {
  describe('where it is offered', () => {
    it('on a workload whose provider has its own firewall', () => {
      const { service } = setup();
      expect(service.isApplicable(firewallOf().cluster)).toBe(true);
    });

    it('not on the control cluster', () => {
      const { service } = setup();
      expect(
        service.isApplicable(
          firewallOf(undefined, { clusterType: 'control' }).cluster,
        ),
      ).toBe(false);
    });

    it('not where the host firewall already is the cluster firewall', () => {
      const { service } = setup({ backend: 'host-nftables' });
      expect(service.isApplicable(firewallOf().cluster)).toBe(false);
    });

    it('refuses to be turned on where it is not offered', async () => {
      const { service, desiredState } = setup({
        backend: 'host-nftables',
      });
      await expect(service.setEnabled('wc1', true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(desiredState.rememberHostLayer).not.toHaveBeenCalled();
    });
  });

  describe('at creation', () => {
    it('is turned on for a new workload', async () => {
      const { service, desiredState } = setup({ firewall: firewallOf() });
      await service.enableAtCreation(firewallOf());
      expect(desiredState.rememberHostLayer).toHaveBeenCalledWith('fw1', {
        enabled: true,
      });
    });

    it('is left alone on a control cluster', async () => {
      const { service, desiredState } = setup();
      await service.enableAtCreation(
        firewallOf(undefined, { clusterType: 'control' }),
      );
      expect(desiredState.rememberHostLayer).not.toHaveBeenCalled();
    });
  });

  describe('sync', () => {
    it('does nothing on a cluster that never turned it on', async () => {
      const { service, nft } = setup({ firewall: firewallOf() });
      await service.sync(firewallOf(), rules);
      expect(nft.applyHostLayer).not.toHaveBeenCalled();
      expect(nft.removeHostLayer).not.toHaveBeenCalled();
    });

    it('applies when on and records what was applied', async () => {
      const { service, nft } = setup();
      const out = await service.sync(firewallOf({ enabled: true }), rules);
      expect(nft.applyHostLayer).toHaveBeenCalledWith('wc1', rules);
      expect(record(out)).toMatchObject({
        enabled: true,
        lastAppliedFingerprint: 'fp-1',
        appliedNodes: 2,
        lastError: null,
        blockedReason: null,
      });
      expect(record(out).appliedAt).toEqual(expect.any(String));
    });

    it('skips the nodes when nothing they would be sent has changed', async () => {
      const { service, nft } = setup();
      await service.sync(
        firewallOf({
          enabled: true,
          lastAppliedFingerprint: 'fp-1',
          appliedAt: '2026-09-27T00:00:00Z',
        }),
        rules,
      );
      expect(nft.applyHostLayer).not.toHaveBeenCalled();
    });

    it('re-applies when the fingerprint moves', async () => {
      const { service, nft } = setup();
      await service.sync(
        firewallOf({ enabled: true, lastAppliedFingerprint: 'fp-0' }),
        rules,
      );
      expect(nft.applyHostLayer).toHaveBeenCalled();
    });

    it('retries after a failure even when the fingerprint is the same', async () => {
      const { service, nft } = setup();
      await service.sync(
        firewallOf({
          enabled: true,
          lastAppliedFingerprint: 'fp-1',
          lastError: 'ssh timed out',
        }),
        rules,
      );
      expect(nft.applyHostLayer).toHaveBeenCalled();
    });

    it('records a closed gate as a reason, not an error', async () => {
      const { service } = setup({
        nft: {
          applyHostLayer: jest
            .fn()
            .mockRejectedValue(new HostLayerBlockedError('no private network')),
        },
      });
      const out = await service.sync(firewallOf({ enabled: true }), rules);
      expect(record(out)).toMatchObject({
        blockedReason: 'no private network',
        lastError: null,
      });
      expect(record(out).lastAppliedFingerprint).toBeUndefined();
    });

    it('records a failure and never throws it', async () => {
      const { service } = setup({
        nft: {
          applyHostLayer: jest.fn().mockRejectedValue(new Error('boom')),
        },
      });
      const out = await service.sync(firewallOf({ enabled: true }), rules);
      expect(record(out).lastError).toBe('boom');
    });

    it('takes the ruleset off the nodes once turned off', async () => {
      const { service, nft } = setup();
      const out = await service.sync(
        firewallOf({ enabled: false, lastAppliedFingerprint: 'fp-1' }),
        rules,
      );
      expect(nft.removeHostLayer).toHaveBeenCalledWith('wc1');
      expect(record(out).lastAppliedFingerprint).toBeNull();
    });

    it('keeps trying to remove it when removal fails', async () => {
      const firewall = firewallOf({
        enabled: false,
        lastAppliedFingerprint: 'fp-1',
      });
      const { service } = setup({
        firewall,
        nft: {
          removeHostLayer: jest.fn().mockRejectedValue(new Error('down')),
        },
      });
      const out = await service.sync(firewall, rules);
      expect(record(out)).toMatchObject({
        lastAppliedFingerprint: 'fp-1',
        lastError: 'down',
      });
      expect(service.toDto(out).state).toBe(HostFirewallLayerState.REMOVING);
    });

    it('does not reach a cluster being deleted', async () => {
      const { service, nft } = setup();
      await service.sync(
        firewallOf({ enabled: true }, { status: 'deleting' }),
        rules,
      );
      expect(nft.applyHostLayer).not.toHaveBeenCalled();
    });
  });

  describe('setEnabled', () => {
    it('turns it on for an existing cluster and applies now', async () => {
      const { service, nft, current } = setup({ firewall: firewallOf() });
      await service.setEnabled('wc1', true);
      expect(nft.applyHostLayer).toHaveBeenCalledWith('wc1', rules);
      expect(service.toDto(current()).state).toBe(
        HostFirewallLayerState.APPLIED,
      );
    });
  });
});

describe('describeHostLayer', () => {
  it.each([
    [false, undefined, HostFirewallLayerState.NOT_APPLICABLE],
    [true, undefined, HostFirewallLayerState.OFF],
    [true, { enabled: true }, HostFirewallLayerState.PENDING],
    [
      true,
      { enabled: true, appliedAt: 'x', lastAppliedFingerprint: 'f' },
      HostFirewallLayerState.APPLIED,
    ],
    [
      true,
      { enabled: true, blockedReason: 'r' },
      HostFirewallLayerState.BLOCKED,
    ],
    [true, { enabled: true, lastError: 'e' }, HostFirewallLayerState.FAILED],
  ])('applicable=%s %j → %s', (applicable, rec, state) => {
    expect(describeHostLayer(applicable, rec as any).state).toBe(state);
  });

  it('carries the reason for the surfaces to show', () => {
    expect(
      describeHostLayer(true, { enabled: true, blockedReason: 'why' }).reason,
    ).toBe('why');
  });
});

describe('FirewallReconciliationService with the host layer', () => {
  const cluster = {
    id: 'wc1',
    provider: 'hetzner',
    clusterType: 'workload',
    nodes: [],
  };
  const build = (hostLayer: any, providerUpdate: jest.Mock) => {
    const firewall = {
      id: 'fw1',
      providerFirewallId: 'hz-1',
      desiredRules: rules,
      desiredHash: 'old',
      metadata: {},
      reconciliationStatus: 'in_sync',
      cluster,
    };
    const desiredState = {
      getFirewallById: jest.fn().mockResolvedValue(firewall),
      canonicalizeRules: (r: FirewallRuleDto[]) => r,
      calculateHash: jest.fn().mockReturnValue('new'),
      updateReconciliationStatus: jest.fn().mockResolvedValue(firewall),
      updateDesiredAndAppliedState: jest.fn().mockResolvedValue(firewall),
      markReconciliationComplete: jest.fn().mockResolvedValue(firewall),
      rememberPayloadFingerprint: jest.fn(),
      rememberAttachment: jest.fn().mockResolvedValue(firewall),
    };
    const providerFactory = {
      getFirewallProvider: () => ({
        updateFirewallRules: providerUpdate,
        getFirewall: jest.fn(async () => null),
      }),
    };
    const caps = {
      isProviderSupported: () => true,
      getCapabilitiesService: () => ({
        getStaticCapabilities: () => ({
          firewall: { supportsSshAllowlist: true, backend: 'managed-api' },
        }),
      }),
    };
    const svc = new FirewallReconciliationService(
      desiredState as any,
      providerFactory as any,
      caps as any,
      {} as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      hostLayer,
    );
    return { svc, desiredState };
  };

  it('syncs the host layer after the provider accepted the rules', async () => {
    const order: string[] = [];
    const providerUpdate = jest.fn(async () => {
      order.push('provider');
    });
    const hostLayer = {
      sync: jest.fn(async (fw: any) => {
        order.push('host');
        return fw;
      }),
    };
    const { svc } = build(hostLayer, providerUpdate);
    await svc.updateAndApplyRules('fw1', rules);
    expect(order).toEqual(['provider', 'host']);
  });

  it('never syncs the host layer when the provider refused', async () => {
    const hostLayer = { sync: jest.fn() };
    const { svc } = build(
      hostLayer,
      jest.fn().mockRejectedValue(new Error('provider down')),
    );
    await expect(svc.updateAndApplyRules('fw1', rules)).rejects.toThrow(
      'provider down',
    );
    expect(hostLayer.sync).not.toHaveBeenCalled();
  });

  it('keeps the provider firewall in sync when the host layer blows up', async () => {
    const hostLayer = {
      sync: jest.fn().mockRejectedValue(new Error('host exploded')),
    };
    const { svc, desiredState } = build(hostLayer, jest.fn());
    await expect(svc.reconcile('fw1')).resolves.toBeDefined();
    expect(desiredState.markReconciliationComplete).toHaveBeenCalled();
    expect(desiredState.updateReconciliationStatus).not.toHaveBeenCalledWith(
      'fw1',
      'error',
      expect.anything(),
    );
  });

  it('still brings the host layer along when the provider rules did not change', async () => {
    const hostLayer = { sync: jest.fn(async (fw: any) => fw) };
    const providerUpdate = jest.fn();
    const { svc, desiredState } = build(hostLayer, providerUpdate);
    desiredState.calculateHash.mockReturnValue('old');
    await svc.updateAndApplyRules('fw1', rules);
    expect(providerUpdate).not.toHaveBeenCalled();
    expect(hostLayer.sync).toHaveBeenCalled();
  });
});
