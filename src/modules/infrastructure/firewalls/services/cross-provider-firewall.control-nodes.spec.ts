import { CrossProviderFirewallService } from './cross-provider-firewall.service';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../../clusters/entities/cluster.entity';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';

const control = {
  id: 'ctl',
  provider: 'hetzner',
  status: ClusterStatus.READY,
  clusterType: ClusterType.CONTROL,
  masterIpAddress: '5.6.7.8',
  metadata: {},
  nodes: [
    { id: 'cm', nodeType: 'master', ipAddress: '5.6.7.8' },
    { id: 'cw', nodeType: 'worker', ipAddress: '5.6.7.9' },
  ],
} as unknown as ClusterEntity;

const workload = {
  id: 'w',
  provider: 'scaleway',
  status: ClusterStatus.READY,
  clusterType: ClusterType.WORKLOAD,
  metadata: {},
  nodes: [{ id: 'n1', nodeType: 'master', ipAddress: '1.2.3.4' }],
} as unknown as ClusterEntity;

const controlRows = [
  {
    role: 'control',
    clusterId: 'ctl',
    nodeId: 'cm',
    endpointHost: '5.6.7.8',
    status: 'active',
  },
  {
    role: 'control',
    clusterId: 'ctl',
    nodeId: 'cw',
    endpointHost: '5.6.7.9',
    status: 'active',
  },
];

const memberRow = {
  role: 'member',
  clusterId: 'w',
  nodeId: 'n1',
  endpointHost: '1.2.3.4',
  status: 'active',
};

function build(live: unknown[]) {
  const apply = jest.fn();
  const firewalls = [
    { id: 'fw-ctl', cluster: control, desiredRules: [] },
    { id: 'fw-w', cluster: workload, desiredRules: [] },
  ];
  const service = new CrossProviderFirewallService(
    {
      listFirewalls: jest.fn().mockResolvedValue(firewalls),
      rememberSuspendedSsh: jest.fn(),
    } as any,
    { updateAndApplyRules: apply } as any,
    {
      find: jest.fn(async (opts?: { where?: unknown }) =>
        opts?.where && !Array.isArray(opts.where) ? [workload] : [control],
      ),
    } as any,
    new ManagementAddressResolver(),
    {
      livePeers: jest.fn().mockResolvedValue(live),
      nodeOverlayFor: jest.fn().mockResolvedValue(undefined),
    } as any,
    { decrypt: (v: string) => v } as any,
  );
  const rulesFor = (id: string): FirewallRuleDto[] =>
    apply.mock.calls.find((c) => c[0] === id)?.[1] ?? [];
  return { service, rulesFor };
}

describe('control nodes on the Flui network, as the firewall sees them', () => {
  beforeEach(() => {
    process.env.FLUI_WG_ENABLED = 'true';
    delete process.env.FLUI_WG_PORT;
  });
  afterEach(() => {
    process.env.FLUI_WG_ENABLED = 'false';
  });

  it('admits members on the tunnel port and never a control node’s own address', async () => {
    const { service, rulesFor } = build([...controlRows, memberRow]);
    await service.reconcileAllPeers();

    const listen = rulesFor('fw-ctl').find(
      (r) => r.description === 'flui:xprovider:wg-listen',
    );
    expect(listen?.sourceIps).toEqual(['1.2.3.4/32']);
  });

  it('opens no tunnel port when only control nodes are on the network', async () => {
    const { service, rulesFor } = build(controlRows);
    await service.reconcileAllPeers();

    expect(
      rulesFor('fw-ctl').some(
        (r) => r.description === 'flui:xprovider:wg-listen',
      ),
    ).toBe(false);
  });

  it('lets SSH to a workload come from every control node, counting only that workload’s members', async () => {
    const { service, rulesFor } = build([...controlRows, memberRow]);
    await service.reconcileAllPeers();

    const ssh = rulesFor('fw-w').find(
      (r) => r.description === 'flui:xprovider:ssh-via-control',
    );
    expect(ssh?.sourceIps).toEqual(['5.6.7.8/32', '5.6.7.9/32']);
  });
});
