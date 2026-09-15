// byos-vnet.service → vnets.service → subnet-calculator → ip-cidr is ESM-only
// and jest can't transform it; we use a mock VNetsService anyway, so stub the
// calculator module to keep the import graph loadable.
jest.mock('../../vnets/utils/subnet-calculator', () => ({
  SubnetCalculator: { validateSubnetInRange: () => true },
}));

import { BadRequestException } from '@nestjs/common';
import {
  ByosVNetService,
  DEFAULT_MANAGED_NODE_NETWORK,
} from './byos-vnet.service';
import { VNetImplementation } from '../../vnets/entities/vnet.entity';
import { NodeType } from '../entities/cluster-node.entity';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

describe('ByosVNetService.ensureClusterVNet', () => {
  function make(
    cluster: any,
    capabilities: Record<string, unknown> = {},
    opts: { attachImpl?: any } = {},
  ) {
    const attachCalls: any[] = [];
    const clusterRepo: any = {
      findOne: jest.fn().mockResolvedValue(cluster),
      update: jest.fn().mockResolvedValue({}),
    };
    const nodeRepo: any = { update: jest.fn().mockResolvedValue({}) };
    const vnetsService: any = {
      registerManualVNet: jest.fn().mockResolvedValue({
        id: 'vnet-1',
        subnets: [{ id: 'sub-1', ipRange: '10.89.0.0/24' }],
      }),
    };
    const subnetsService: any = {
      attachServerToSubnet: jest
        .fn()
        .mockImplementation((subnetId: string, dto: any) => {
          attachCalls.push({ subnetId, ...dto });
          return opts.attachImpl ? opts.attachImpl(dto) : Promise.resolve({});
        }),
    };
    let nextAddress = 0;
    const wireguard: any = {
      reserveAddress: jest.fn().mockImplementation(async () => ({
        managementIp: `10.201.0.${++nextAddress}`,
      })),
    };
    const capabilitiesFactory: any = {
      getCapabilitiesService: jest.fn().mockReturnValue({
        getStaticCapabilities: jest
          .fn()
          .mockReturnValue({ supportsFluiManagedVNet: true, ...capabilities }),
      }),
    };
    const svc = new ByosVNetService(
      clusterRepo,
      nodeRepo,
      vnetsService,
      subnetsService,
      wireguard,
      capabilitiesFactory,
    );
    return {
      svc,
      clusterRepo,
      nodeRepo,
      wireguard,
      capabilitiesFactory,
      vnetsService,
      subnetsService,
      attachCalls,
    };
  }

  const cluster = (over: Partial<any> = {}) => ({
    id: 'c-1',
    name: 'flui-byos',
    provider: 'byos',
    masterIpAddress: '10.89.0.2',
    metadata: { byos: { nodeNetwork: '10.89.0.0/24' } },
    nodes: [
      {
        id: 'n-m',
        nodeType: NodeType.MASTER,
        serverName: 'master',
        privateIp: '10.89.0.2',
      },
      {
        id: 'n-w',
        nodeType: NodeType.WORKER,
        serverName: 'w1',
        privateIp: '10.89.0.5',
      },
    ],
    ...over,
  });

  it('registers the VNet, sets vnetConfig + syncs nodeNetwork, attaches all nodes', async () => {
    const { svc, clusterRepo, nodeRepo, vnetsService, attachCalls } =
      make(cluster());
    const res = await svc.ensureClusterVNet('c-1');

    expect(vnetsService.registerManualVNet).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterId: 'c-1',
        provider: CloudProvider.BYOS,
        ipRange: '10.89.0.0/24',
      }),
    );
    expect(clusterRepo.update).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          vnetConfig: expect.objectContaining({
            vnetId: 'vnet-1',
            subnetId: 'sub-1',
          }),
          byos: expect.objectContaining({ nodeNetwork: '10.89.0.0/24' }),
        }),
      }),
    );
    expect(attachCalls.map((a) => a.ip).sort()).toEqual([
      '10.89.0.2',
      '10.89.0.5',
    ]);
    expect(nodeRepo.update).toHaveBeenCalledTimes(2);
    expect(res.attachedNodes).toBe(2);
    expect(res.ipRange).toBe('10.89.0.0/24');
  });

  describe('a network Flui builds', () => {
    const managed = { implementation: VNetImplementation.WIREGUARD };

    it('assigns each node an address instead of reading one off it', async () => {
      // These machines have no private address to read: that is the case the
      // Flui-built network exists for.
      const bare = cluster({
        metadata: {},
        masterIpAddress: '203.0.113.10',
        nodes: [
          { id: 'n-m', nodeType: NodeType.MASTER, serverName: 'master' },
          { id: 'n-w', nodeType: NodeType.WORKER, serverName: 'w1' },
        ],
      });
      const { svc, wireguard, nodeRepo, attachCalls } = make(bare);

      const res = await svc.ensureClusterVNet('c-1', managed);

      expect(wireguard.reserveAddress).toHaveBeenCalledTimes(2);
      expect(attachCalls.map((a) => a.ip)).toEqual([
        '10.201.0.1',
        '10.201.0.2',
      ]);
      expect(nodeRepo.update).toHaveBeenCalledWith(
        'n-m',
        expect.objectContaining({ privateIp: '10.201.0.1' }),
      );
      expect(res.attachedNodes).toBe(2);
    });

    it('never derives the range from an address the nodes do not have', async () => {
      const { svc, vnetsService } = make(
        cluster({
          metadata: {},
          masterIpAddress: '203.0.113.10',
          nodes: [{ id: 'n-m', nodeType: NodeType.MASTER, serverName: 'm' }],
        }),
      );
      await svc.ensureClusterVNet('c-1', managed);
      expect(vnetsService.registerManualVNet).toHaveBeenCalledWith(
        expect.objectContaining({
          ipRange: DEFAULT_MANAGED_NODE_NETWORK,
          implementation: VNetImplementation.WIREGUARD,
        }),
      );
    });

    it('still honours a range the operator chose', async () => {
      const { svc, vnetsService } = make(cluster({ metadata: {} }));
      await svc.ensureClusterVNet('c-1', {
        ...managed,
        ipRange: '10.202.7.0/24',
      });
      expect(vnetsService.registerManualVNet).toHaveBeenCalledWith(
        expect.objectContaining({ ipRange: '10.202.7.0/24' }),
      );
    });

    it('refuses to build one where the provider already has networks', async () => {
      const { svc } = make(cluster({ provider: 'hetzner' }), {
        supportsFluiManagedVNet: false,
      });
      await expect(svc.ensureClusterVNet('c-1', managed)).rejects.toThrow(
        /networks of its own/,
      );
    });

    it('serves a provider that is not BYOS but has no network either', async () => {
      // Contabo is in the same position: the question is what the provider
      // offers, not what it is called — and the network must be recorded under
      // that provider, not under BYOS.
      const { svc, vnetsService } = make(cluster({ provider: 'contabo' }));
      await svc.ensureClusterVNet('c-1', managed);
      expect(vnetsService.registerManualVNet).toHaveBeenCalledWith(
        expect.objectContaining({
          implementation: VNetImplementation.WIREGUARD,
          provider: 'contabo',
        }),
      );
    });

    it('leaves an operator-wired LAN alone', async () => {
      const { svc, wireguard, attachCalls } = make(cluster());
      await svc.ensureClusterVNet('c-1');
      expect(wireguard.reserveAddress).not.toHaveBeenCalled();
      expect(attachCalls.map((a) => a.ip).sort()).toEqual([
        '10.89.0.2',
        '10.89.0.5',
      ]);
    });
  });

  it('derives a /24 from the master private IP when nothing is declared', async () => {
    const { svc, vnetsService } = make(cluster({ metadata: {} }));
    await svc.ensureClusterVNet('c-1');
    expect(vnetsService.registerManualVNet).toHaveBeenCalledWith(
      expect.objectContaining({ ipRange: '10.89.0.0/24' }),
    );
  });

  it('honours an explicit ipRange override', async () => {
    const { svc, vnetsService } = make(cluster({ metadata: {} }));
    await svc.ensureClusterVNet('c-1', { ipRange: '10.10.0.0/16' });
    expect(vnetsService.registerManualVNet).toHaveBeenCalledWith(
      expect.objectContaining({ ipRange: '10.10.0.0/16' }),
    );
  });

  it('rejects a non-BYOS cluster', async () => {
    const { svc } = make(cluster({ provider: 'hetzner' }));
    await expect(svc.ensureClusterVNet('c-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('records a warning but completes when a node IP is rejected by the subnet', async () => {
    const { svc } = make(
      cluster(),
      {},
      {
        attachImpl: (dto: any) => {
          if (dto.ip === '10.89.0.5') throw new Error('not within network');
          return Promise.resolve({});
        },
      },
    );
    const res = await svc.ensureClusterVNet('c-1');
    expect(res.attachedNodes).toBe(1);
    expect(res.warnings).toHaveLength(1);
  });
});
