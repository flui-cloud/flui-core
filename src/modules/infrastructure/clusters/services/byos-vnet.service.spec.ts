// byos-vnet.service → vnets.service → subnet-calculator → ip-cidr is ESM-only
// and jest can't transform it; we use a mock VNetsService anyway, so stub the
// calculator module to keep the import graph loadable.
jest.mock('../../vnets/utils/subnet-calculator', () => ({
  SubnetCalculator: { validateSubnetInRange: () => true },
}));

import { NotFoundException } from '@nestjs/common';
import { ByosVNetService } from './byos-vnet.service';
import { NodeType } from '../entities/cluster-node.entity';

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
    const network = {
      id: 'vnet-1',
      ipRange: '10.250.0.0/16',
      subnets: [] as any[],
    };
    const vnetsService: any = {
      ensureFluiNetwork: jest.fn().mockResolvedValue(network),
      ensureManualSubnet: jest
        .fn()
        .mockImplementation(async (vnetId: string, ipRange: string) => {
          const sub = { id: `sub-${network.subnets.length + 1}`, ipRange };
          network.subnets.push(sub);
          return sub;
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
        managementIp: `10.250.0.${++nextAddress}`,
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
      network,
    };
  }

  const cluster = (over: Partial<any> = {}) => ({
    id: 'c-1',
    name: 'flui-byos',
    provider: 'byos',
    // Deliberately a public address and no private one: the machines this
    // serves have nothing private to read, which is the whole point.
    masterIpAddress: '203.0.113.10',
    metadata: {},
    nodes: [
      { id: 'n-m', nodeType: NodeType.MASTER, serverName: 'master' },
      { id: 'n-w', nodeType: NodeType.WORKER, serverName: 'w1' },
    ],
    ...over,
  });

  it('puts the cluster on the one Flui network, in a subnet of its own', async () => {
    const { svc, vnetsService, clusterRepo } = make(cluster());

    const res = await svc.ensureClusterVNet('c-1');

    expect(vnetsService.ensureFluiNetwork).toHaveBeenCalled();
    expect(res.ipRange).toBe('10.250.0.0/24');
    expect(clusterRepo.update).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          vnetConfig: expect.objectContaining({
            vnetId: 'vnet-1',
            subnetId: 'sub-1',
          }),
        }),
      }),
    );
  });

  it('gives every node an address instead of reading one off it', async () => {
    const { svc, wireguard, nodeRepo, attachCalls } = make(cluster());

    const res = await svc.ensureClusterVNet('c-1');

    expect(wireguard.reserveAddress).toHaveBeenCalledTimes(2);
    expect(attachCalls.map((a) => a.ip)).toEqual(['10.250.0.1', '10.250.0.2']);
    expect(nodeRepo.update).toHaveBeenCalledWith(
      'n-m',
      expect.objectContaining({ privateIp: '10.250.0.1' }),
    );
    expect(res.attachedNodes).toBe(2);
  });

  it('never reads a private address off the machine', async () => {
    // On a host running containers the address read off the machine is a
    // container bridge, not a network it shares with anything.
    const { svc, attachCalls } = make(
      cluster({
        nodes: [
          {
            id: 'n-m',
            nodeType: NodeType.MASTER,
            serverName: 'master',
            privateIp: '10.88.0.1',
          },
        ],
      }),
    );

    await svc.ensureClusterVNet('c-1');

    expect(attachCalls[0].ip).toBe('10.250.0.1');
    expect(attachCalls[0].ip).not.toBe('10.88.0.1');
  });

  it('keeps the block a cluster was already given', async () => {
    // The addresses inside it are in certificates and in other nodes' peer
    // configs: a cluster that came back on a different block would be a
    // different cluster to everyone else.
    const { svc, network } = make(cluster());
    await svc.ensureClusterVNet('c-1');

    const again = make(
      cluster({ metadata: { vnetConfig: { subnetId: 'sub-1' } } }),
    );
    again.network.subnets.push(network.subnets[0]);
    const res = await again.svc.ensureClusterVNet('c-1');

    expect(res.subnetId).toBe('sub-1');
    expect(again.vnetsService.ensureManualSubnet).not.toHaveBeenCalled();
  });

  it('gives the next cluster the next block', async () => {
    const { svc, network } = make(cluster());
    await svc.ensureClusterVNet('c-1');

    const second = make(cluster({ id: 'c-2', name: 'other' }));
    second.network.subnets.push(...network.subnets);
    const res = await second.svc.ensureClusterVNet('c-2');

    expect(res.ipRange).toBe('10.250.1.0/24');
  });

  it('honours a range chosen to dodge a collision', async () => {
    const { svc, vnetsService } = make(cluster());
    await svc.ensureClusterVNet('c-1', { ipRange: '10.202.0.0/16' });
    expect(vnetsService.ensureFluiNetwork).toHaveBeenCalledWith(
      '10.202.0.0/16',
    );
  });

  it('refuses a provider that has networks of its own', async () => {
    const { svc } = make(cluster({ provider: 'hetzner' }), {
      supportsFluiManagedVNet: false,
    });
    await expect(svc.ensureClusterVNet('c-1')).rejects.toThrow(
      /networks of its own/,
    );
  });

  it('serves any provider that has none, not only BYOS', async () => {
    const { svc, vnetsService } = make(cluster({ provider: 'contabo' }));
    await svc.ensureClusterVNet('c-1');
    expect(vnetsService.ensureFluiNetwork).toHaveBeenCalled();
  });

  it('records a warning but completes when a node is rejected', async () => {
    const { svc } = make(
      cluster(),
      {},
      {
        attachImpl: (dto: any) => {
          if (dto.ip === '10.250.0.2') throw new Error('not within network');
          return Promise.resolve({});
        },
      },
    );

    const res = await svc.ensureClusterVNet('c-1');

    expect(res.attachedNodes).toBe(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/not within network/);
  });

  it('refuses a cluster that does not exist', async () => {
    const { svc } = make(null);
    await expect(svc.ensureClusterVNet('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
