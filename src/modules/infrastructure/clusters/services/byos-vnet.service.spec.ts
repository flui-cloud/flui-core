// byos-vnet.service → vnets.service → subnet-calculator → ip-cidr is ESM-only
// and jest can't transform it; we use a mock VNetsService anyway, so stub the
// calculator module to keep the import graph loadable.
jest.mock('../../vnets/utils/subnet-calculator', () => ({
  SubnetCalculator: { validateSubnetInRange: () => true },
}));

import { BadRequestException } from '@nestjs/common';
import { ByosVNetService } from './byos-vnet.service';
import { NodeType } from '../entities/cluster-node.entity';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

describe('ByosVNetService.ensureClusterVNet', () => {
  function make(cluster: any, opts: { attachImpl?: any } = {}) {
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
    const svc = new ByosVNetService(
      clusterRepo,
      nodeRepo,
      vnetsService,
      subnetsService,
    );
    return {
      svc,
      clusterRepo,
      nodeRepo,
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
    const { svc } = make(cluster(), {
      attachImpl: (dto: any) => {
        if (dto.ip === '10.89.0.5') throw new Error('not within network');
        return Promise.resolve({});
      },
    });
    const res = await svc.ensureClusterVNet('c-1');
    expect(res.attachedNodes).toBe(1);
    expect(res.warnings).toHaveLength(1);
  });
});
