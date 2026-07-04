import { Test } from '@nestjs/testing';
import { CrossProviderFirewallService } from './cross-provider-firewall.service';
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

function cluster(over: Partial<ClusterEntity>): ClusterEntity {
  return {
    id: 'c',
    provider: 'hetzner',
    status: ClusterStatus.READY,
    clusterType: ClusterType.WORKLOAD,
    nodes: [],
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
  });

const peerOf = (rules: FirewallRuleDto[]) =>
  rules.filter((r) => r.description?.startsWith('flui:xprovider:'));

describe('CrossProviderFirewallService', () => {
  let service: CrossProviderFirewallService;
  let list: jest.Mock;
  let apply: jest.Mock;

  beforeEach(async () => {
    list = jest.fn();
    apply = jest.fn().mockResolvedValue({});
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
      ],
    }).compile();
    service = mod.get(CrossProviderFirewallService);
    delete process.env.FLUI_OBS_INGEST_NODEPORTS;
    delete process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC;
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

  it('is a no-op for a same-provider workload (uses the vnet)', async () => {
    process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC = 'true';
    const workload = cluster({
      id: 'w',
      provider: 'hetzner',
      clusterType: ClusterType.WORKLOAD,
      nodes: [{ ipAddress: '1.2.3.4' }] as any,
    });
    list.mockResolvedValue([
      firewall('fw-ctl', control()),
      firewall('fw-w', workload),
    ]);

    await service.reconcileAllPeers();

    expect(peerOf(rulesFor('fw-ctl'))).toEqual([]); // no cross-provider workloads
    expect(peerOf(rulesFor('fw-w'))).toEqual([]); // same-provider → no 6443 rule
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
});
