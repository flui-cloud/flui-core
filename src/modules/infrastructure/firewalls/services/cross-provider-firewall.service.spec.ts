import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CrossProviderFirewallService } from './cross-provider-firewall.service';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { WireGuardPeerService } from '../../networking/services/wireguard-peer.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { FirewallDesiredStateService } from './firewall-desired-state.service';
import { FirewallReconciliationService } from './firewall-reconciliation.service';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../../clusters/entities/cluster.entity';
import { ClusterFirewallEntity } from '../entities/cluster-firewall.entity';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';

const BASE_RULES: FirewallRuleDto[] = [
  {
    description: 'SSH',
    direction: 'in',
    protocol: 'tcp',
    port: '22',
    sourceIps: ['0.0.0.0/0'],
  },
  {
    description: 'HTTP',
    direction: 'in',
    protocol: 'tcp',
    port: '80',
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

const SHARED_VNET = { vnetConfig: { vnetId: 'v1', subnetId: 's1' } };

function cluster(over: Partial<ClusterEntity>): ClusterEntity {
  return {
    id: 'c',
    provider: 'hetzner',
    status: ClusterStatus.READY,
    clusterType: ClusterType.WORKLOAD,
    nodes: [],
    metadata: SHARED_VNET,
    ...over,
  } as ClusterEntity;
}

function firewall(id: string, c: ClusterEntity): ClusterFirewallEntity {
  return {
    id,
    clusterId: c.id,
    cluster: c,
    desiredRules: [...BASE_RULES],
  } as ClusterFirewallEntity;
}

const control = () =>
  cluster({
    id: 'ctl',
    provider: 'hetzner',
    clusterType: ClusterType.CONTROL,
    masterIpAddress: '5.6.7.8',
    masterPrivateIp: '10.0.1.1',
  });

const peerOf = (rules: FirewallRuleDto[]) =>
  rules.filter((r) => r.description?.startsWith('flui:xprovider:'));

describe('CrossProviderFirewallService', () => {
  let service: CrossProviderFirewallService;
  let wgEgress: jest.Mock;
  let wgNodeOverlay: jest.Mock;
  let wgControlPeer: jest.Mock;
  let list: jest.Mock;
  let apply: jest.Mock;
  let clusterFind: jest.Mock;

  beforeEach(async () => {
    list = jest.fn();
    apply = jest.fn().mockResolvedValue({});
    // The control is resolved from the cluster repository (a BYOS control owns
    // no firewall). Default: derive control-type clusters from the same
    // firewall fixtures; tests for firewall-less controls override this.
    clusterFind = jest.fn(async () => {
      const fws: ClusterFirewallEntity[] = (await list()) ?? [];
      return fws
        .map((f) => f.cluster)
        .filter(
          (c): c is ClusterEntity =>
            !!c &&
            (c.clusterType === ClusterType.CONTROL ||
              c.clusterType === ClusterType.OBSERVABILITY),
        );
    });
    wgEgress = jest.fn().mockResolvedValue([]);
    wgNodeOverlay = jest.fn().mockResolvedValue(undefined);
    wgControlPeer = jest.fn().mockResolvedValue(null);
    const mod = await Test.createTestingModule({
      providers: [
        CrossProviderFirewallService,
        {
          provide: FirewallDesiredStateService,
          useValue: { listFirewalls: list },
        },
        {
          provide: FirewallReconciliationService,
          useValue: { updateAndApplyRules: apply },
        },
        {
          provide: getRepositoryToken(ClusterEntity),
          useValue: { find: clusterFind },
        },
        // The real resolver, not a mock: it is pure, and mocking it would hide
        // exactly the drift between kubeconfig endpoint and firewall rule that
        // it exists to prevent.
        ManagementAddressResolver,
        {
          provide: WireGuardPeerService,
          useValue: {
            memberEgressIps: wgEgress,
            nodeOverlayFor: wgNodeOverlay,
            controlPeer: wgControlPeer,
          },
        },
        {
          provide: EncryptionService,
          useValue: { decrypt: (v: string) => v.replace(/^enc:/, '') },
        },
      ],
    }).compile();
    service = mod.get(CrossProviderFirewallService);
    delete process.env.FLUI_OBS_INGEST_NODEPORTS;
    delete process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC;
    delete process.env.FLUI_WG_ENABLED;
    delete process.env.FLUI_WG_PORT;
  });

  const rulesFor = (fwId: string): FirewallRuleDto[] => {
    const call = apply.mock.calls.find((c) => c[0] === fwId);
    return call ? call[1] : [];
  };

  it('does nothing when there is no control cluster', async () => {
    const w = cluster({ id: 'w', clusterType: ClusterType.WORKLOAD });
    list.mockResolvedValue([firewall('fw-w', w)]);
    await service.reconcileAllPeers();
    expect(apply).not.toHaveBeenCalled();
  });

  it('adds a 6443→master public IP rule on a cross-provider workload, preserving base rules', async () => {
    const workload = cluster({
      id: 'w',
      provider: 'byos',
      clusterType: ClusterType.WORKLOAD,
      nodes: [{ ipAddress: '1.2.3.4' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', control()),
      firewall('fw-w', workload),
    ]);

    await service.reconcileAllPeers();

    const wr = rulesFor('fw-w');
    expect(wr).toEqual(expect.arrayContaining(BASE_RULES));
    expect(peerOf(wr)).toEqual([
      {
        description: 'flui:xprovider:apiserver',
        direction: 'in',
        protocol: 'tcp',
        port: '6443',
        sourceIps: ['5.6.7.8/32'],
      },
    ]);
  });

  it('does NOT open the unauthenticated obs ingest ports by default (vnet-only)', async () => {
    const workload = cluster({
      id: 'w',
      provider: 'byos',
      nodes: [{ ipAddress: '1.1.1.1' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', control()),
      firewall('fw-w', workload),
    ]);

    await service.reconcileAllPeers();

    expect(peerOf(rulesFor('fw-ctl'))).toEqual([]); // gated off
  });

  it('opens the control ingest ports to every cross-provider workload node IP when explicitly enabled', async () => {
    process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC = 'true';
    const w1 = cluster({
      id: 'w1',
      provider: 'byos',
      nodes: [{ ipAddress: '1.1.1.1' }, { ipAddress: '2.2.2.2' }] as any,
    });
    const w2 = cluster({
      id: 'w2',
      provider: 'byos',
      nodes: [{ ipAddress: '3.3.3.3' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', control()),
      firewall('fw-w1', w1),
      firewall('fw-w2', w2),
    ]);

    await service.reconcileAllPeers();

    expect(peerOf(rulesFor('fw-ctl'))).toEqual([
      {
        description: 'flui:xprovider:obs-ingest-30100',
        direction: 'in',
        protocol: 'tcp',
        port: '30100',
        sourceIps: ['1.1.1.1/32', '2.2.2.2/32', '3.3.3.3/32'],
      },
    ]);
  });

  it('drops out-of-range / non-numeric ingest ports (a typo must never open an arbitrary port)', async () => {
    process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC = 'true';
    process.env.FLUI_OBS_INGEST_NODEPORTS = '30100,22,6443,3o428,30428';
    const workload = cluster({
      id: 'w',
      provider: 'byos',
      nodes: [{ ipAddress: '1.1.1.1' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', control()),
      firewall('fw-w', workload),
    ]);

    await service.reconcileAllPeers();

    const ports = peerOf(rulesFor('fw-ctl')).map((r) => r.port);
    expect(ports).toEqual(['30100', '30428']); // 22 / 6443 / '3o428' rejected
  });

  it('is a no-op for a same-provider workload on the same vnet', async () => {
    process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC = 'true';
    const workload = cluster({
      id: 'w',
      provider: 'hetzner',
      clusterType: ClusterType.WORKLOAD,
      // A node actually attached to the shared VNet has a private IP; without
      // one the kubeconfig falls back to the public address and the rule is
      // then required, which is what the two cases below assert.
      nodes: [{ ipAddress: '1.2.3.4', privateIp: '10.0.1.4' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', control()),
      firewall('fw-w', workload),
    ]);

    await service.reconcileAllPeers();

    expect(peerOf(rulesFor('fw-ctl'))).toEqual([]); // no cross-provider workloads
    expect(peerOf(rulesFor('fw-w'))).toEqual([]); // same-provider → no 6443 rule
  });

  it('opens 6443 for a same-provider workload on a DIFFERENT vnet', async () => {
    // The defect that motivated the shared resolver: the kubeconfig already
    // baked this workload's public IP, while the rule was skipped because the
    // provider matched. Public endpoint, closed port, unmanageable cluster.
    const workload = cluster({
      id: 'w',
      provider: 'hetzner',
      clusterType: ClusterType.WORKLOAD,
      metadata: { vnetConfig: { vnetId: 'other-vnet' } },
      nodes: [{ ipAddress: '1.2.3.4', privateIp: '10.9.9.4' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', control()),
      firewall('fw-w', workload),
    ]);

    await service.reconcileAllPeers();

    expect(peerOf(rulesFor('fw-w'))).toEqual([
      {
        description: 'flui:xprovider:apiserver',
        direction: 'in',
        protocol: 'tcp',
        port: '6443',
        sourceIps: ['5.6.7.8/32'],
      },
    ]);
  });

  it('opens 6443 when the control has no vnet recorded', async () => {
    const ctl = control();
    (ctl as any).metadata = {};
    const workload = cluster({
      id: 'w',
      clusterType: ClusterType.WORKLOAD,
      nodes: [{ ipAddress: '1.2.3.4', privateIp: '10.0.1.4' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', ctl),
      firewall('fw-w', workload),
    ]);

    await service.reconcileAllPeers();

    // The kubeconfig cannot prove the private path either, so it bakes the
    // public address — the rule has to follow it there.
    expect(peerOf(rulesFor('fw-w'))).toHaveLength(1);
  });

  it('strips stale peer rules and re-derives them (idempotent), never duplicating', async () => {
    const ctl = cluster({
      id: 'ctl',
      provider: 'hetzner',
      clusterType: ClusterType.CONTROL,
      masterIpAddress: '9.9.9.9',
    });
    const workload = cluster({
      id: 'w',
      provider: 'byos',
      clusterType: ClusterType.WORKLOAD,
      nodes: [{ ipAddress: '1.2.3.4' }] as any,
    });
    const fwW = firewall('fw-w', workload);
    fwW.desiredRules = [
      ...BASE_RULES,
      {
        description: 'flui:xprovider:apiserver',
        direction: 'in',
        protocol: 'tcp',
        port: '6443',
        sourceIps: ['0.0.0.0/32'],
      },
    ];
    list.mockResolvedValue([firewall('fw-ctl', ctl), fwW]);

    await service.reconcileAllPeers();

    const peer = peerOf(rulesFor('fw-w'));
    expect(peer).toHaveLength(1);
    expect(peer[0].sourceIps).toEqual(['9.9.9.9/32']); // re-derived to current master IP
  });

  it('resolves a firewall-less BYOS control and uses its public host for the 6443 peer rule', async () => {
    const byosControl = cluster({
      id: 'ctl-byos',
      provider: 'byos',
      clusterType: ClusterType.CONTROL,
      masterIpAddress: '10.88.0.2', // internal (e.g. Podman) address
      metadata: { byos: { host: '109.1.2.3' } },
    });
    const workload = cluster({
      id: 'w',
      provider: 'hetzner',
      clusterType: ClusterType.WORKLOAD,
      nodes: [{ ipAddress: '1.2.3.4' }] as any,
    });
    // The BYOS control owns NO firewall — it must still be resolved (from the
    // cluster repo) and its operator-declared public host must source the rule.
    list.mockResolvedValue([firewall('fw-w', workload)]);
    clusterFind.mockResolvedValue([byosControl]);

    await service.reconcileAllPeers();

    expect(peerOf(rulesFor('fw-w'))).toEqual([
      {
        description: 'flui:xprovider:apiserver',
        direction: 'in',
        protocol: 'tcp',
        port: '6443',
        sourceIps: ['109.1.2.3/32'],
      },
    ]);
  });

  it('skips deleted clusters (no rule, and no node IPs contributed)', async () => {
    process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC = 'true';
    const gone = cluster({
      id: 'w',
      provider: 'byos',
      status: ClusterStatus.DELETED,
      nodes: [{ ipAddress: '1.2.3.4' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', control()),
      firewall('fw-w', gone),
    ]);

    await service.reconcileAllPeers();

    expect(apply.mock.calls.some((c) => c[0] === 'fw-w')).toBe(false);
    expect(peerOf(rulesFor('fw-ctl'))).toEqual([]);
  });

  describe('the WireGuard overlay port', () => {
    const withOverlay = async (egress: string[]) => {
      process.env.FLUI_WG_ENABLED = 'true';
      wgEgress.mockResolvedValue(egress);
      list.mockResolvedValue([firewall('fw-ctl', control())]);
      await service.reconcileAllPeers();
      return peerOf(rulesFor('fw-ctl'));
    };

    it('opens UDP on the control to any address', async () => {
      // Not scoped to known peers: a member has to dial in before it can be
      // known, and could not dial in until it was. WireGuard answers an unknown
      // peer with silence, so the address never was the identity.
      expect(await withOverlay(['5.6.7.8/32'])).toEqual([
        {
          description: 'flui:xprovider:wg-listen',
          direction: 'in',
          protocol: 'udp',
          port: '51821',
          sourceIps: ['0.0.0.0/0', '::/0'],
        },
      ]);
    });

    it('opens nothing while the overlay is off', async () => {
      wgEgress.mockResolvedValue(['5.6.7.8/32']);
      list.mockResolvedValue([firewall('fw-ctl', control())]);
      await service.reconcileAllPeers();
      expect(peerOf(rulesFor('fw-ctl'))).toEqual([]);
    });

    it('opens it before any peer exists, which is the whole point', async () => {
      // Seen live: revoking the last peers closed the port, and the next node
      // created could not join until a firewall pass reopened it.
      expect(await withOverlay([])).toHaveLength(1);
    });

    it('honours a configured port', async () => {
      process.env.FLUI_WG_PORT = '51999';
      const rules = await withOverlay(['5.6.7.8/32']);
      expect(rules[0]).toMatchObject({ port: '51999' });
    });

    it('ignores a nonsensical port rather than rendering it', async () => {
      process.env.FLUI_WG_PORT = 'banana';
      const rules = await withOverlay(['5.6.7.8/32']);
      expect(rules[0]).toMatchObject({ port: '51821' });
    });

    it('keeps the public rules working when the peer table cannot be read', async () => {
      // The overlay is not entitled to break the rules that keep existing
      // clusters manageable.
      process.env.FLUI_WG_ENABLED = 'true';
      wgEgress.mockRejectedValue(new Error('db down'));
      const workload = cluster({
        id: 'w',
        provider: 'ovh',
        clusterType: ClusterType.WORKLOAD,
        nodes: [{ ipAddress: '1.2.3.4', privateIp: '10.9.9.4' }] as any,
      });
      list.mockResolvedValue([
        firewall('fw-ctl', control()),
        firewall('fw-w', workload),
      ]);

      await service.reconcileAllPeers();

      // The tunnel port no longer depends on that table at all.
      expect(peerOf(rulesFor('fw-ctl'))).toHaveLength(1);
      expect(peerOf(rulesFor('fw-w'))).toHaveLength(1);
    });

    it('sits alongside the obs ingest rules rather than replacing them', async () => {
      process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC = 'true';
      process.env.FLUI_WG_ENABLED = 'true';
      wgEgress.mockResolvedValue(['5.6.7.8/32']);
      const workload = cluster({
        id: 'w',
        provider: 'ovh',
        clusterType: ClusterType.WORKLOAD,
        nodes: [{ ipAddress: '1.2.3.4' }] as any,
      });
      list.mockResolvedValue([
        firewall('fw-ctl', control()),
        firewall('fw-w', workload),
      ]);

      await service.reconcileAllPeers();

      const descriptions = peerOf(rulesFor('fw-ctl')).map((r) => r.description);
      expect(descriptions).toContain('flui:xprovider:wg-listen');
      expect(descriptions).toContain('flui:xprovider:obs-ingest-30100');
    });
  });

  describe('the public 6443 rule and the kubeconfig move together', () => {
    const crossProviderWorkload = () =>
      cluster({
        id: 'w',
        provider: 'ovh',
        clusterType: ClusterType.WORKLOAD,
        nodes: [
          {
            id: 'n1',
            nodeType: 'master',
            ipAddress: '1.2.3.4',
            privateIp: '10.9.9.4',
          },
        ] as any,
      });

    it('keeps the rule while the node is not on a working tunnel', async () => {
      wgNodeOverlay.mockResolvedValue({
        nodeAddress: '10.250.0.2',
        enrolled: false,
      });
      list.mockResolvedValue([
        firewall('fw-ctl', control()),
        firewall('fw-w', crossProviderWorkload()),
      ]);

      await service.reconcileAllPeers();

      expect(peerOf(rulesFor('fw-w'))).toHaveLength(1);
    });

    it('keeps the public door open until the kubeconfig has actually moved', async () => {
      // The peer is enrolled, which used to be enough to withdraw the rule. It
      // is not: the kubeconfig still names the public address, so withdrawing
      // now leaves the control unable to reach the cluster at either address.
      // Seen live on a workload whose certificate did not yet name its overlay
      // address — public closed, tunnel unusable, cluster stranded.
      wgNodeOverlay.mockResolvedValue({
        nodeAddress: '10.250.0.2',
        enrolled: true,
      });
      const stillPublic = crossProviderWorkload();
      (stillPublic as any).kubeconfigEncrypted =
        'enc:server: https://1.2.3.4:6443';
      list.mockResolvedValue([
        firewall('fw-ctl', control()),
        firewall('fw-w', stillPublic),
      ]);

      await service.reconcileAllPeers();

      expect(peerOf(rulesFor('fw-w'))).toHaveLength(1);
    });

    it('withdraws it once the kubeconfig names the overlay', async () => {
      wgNodeOverlay.mockResolvedValue({
        nodeAddress: '10.250.0.2',
        enrolled: true,
      });
      const moved = crossProviderWorkload();
      (moved as any).kubeconfigEncrypted =
        'enc:server: https://10.250.0.2:6443';
      list.mockResolvedValue([
        firewall('fw-ctl', control()),
        firewall('fw-w', moved),
      ]);

      await service.reconcileAllPeers();

      expect(peerOf(rulesFor('fw-w'))).toEqual([]);
    });

    it('never reopens the public port once the kubeconfig has moved', async () => {
      // The peer has gone stale, which used to read as "back to public". The
      // kubeconfig already names the overlay address, so nothing would use that
      // port — reopening it would expose a door no one walks through.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      wgNodeOverlay.mockResolvedValue({
        nodeAddress: '10.250.0.2',
        enrolled: false,
      });
      const moved = crossProviderWorkload();
      (moved as any).kubeconfigEncrypted =
        'enc:server: https://10.250.0.2:6443';
      list.mockResolvedValue([
        firewall('fw-ctl', control()),
        firewall('fw-w', moved),
      ]);

      await service.reconcileAllPeers();

      expect(peerOf(rulesFor('fw-w'))).toEqual([]);
    });

    it('keeps the rule when the overlay cannot be read at all', async () => {
      // A failure to answer must never be read as "the tunnel is fine".
      wgNodeOverlay.mockRejectedValue(new Error('db down'));
      list.mockResolvedValue([
        firewall('fw-ctl', control()),
        firewall('fw-w', crossProviderWorkload()),
      ]);

      await service.reconcileAllPeers();

      expect(peerOf(rulesFor('fw-w'))).toHaveLength(1);
    });
  });
});
