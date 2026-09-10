import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
jest.mock('../../vnets/services/vnets.service', () => ({
  VNetsService: class {},
}));
jest.mock('../../vnets/services/subnets.service', () => ({
  SubnetsService: class {},
}));

import { ClusterVNetService } from './cluster-vnet.service';

describe('ClusterVNetService.attachClusterToVNet', () => {
  const dto = { vnetId: 'vnet-1', subnetId: 'subnet-1', autoAssignIp: true };

  function build({
    cluster,
    provider,
    vnet,
  }: {
    cluster: unknown;
    provider: unknown;
    vnet?: unknown;
  }) {
    const clusterRepo = {
      findOne: jest.fn().mockResolvedValue(cluster),
    };
    const operationRepo = {
      create: jest.fn((x: object) => ({ id: 'op-1', ...x })),
      save: jest.fn(async (x: object) => x),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const providerFactory = {
      getProvider: jest.fn().mockReturnValue(provider),
    };
    const vnetsService = {
      getVNet: jest.fn().mockResolvedValue(vnet),
    };
    const subnetsService = { listSubnets: jest.fn() };
    const service = new ClusterVNetService(
      clusterRepo as never,
      operationRepo as never,
      queue as never,
      providerFactory as never,
      vnetsService as never,
      subnetsService as never,
    );
    return { service, clusterRepo, operationRepo, queue, providerFactory };
  }

  it('throws NotFoundException when cluster does not exist', async () => {
    const { service } = build({ cluster: null, provider: {} });
    await expect(service.attachClusterToVNet('missing', dto)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws BadRequestException when cluster has no nodes', async () => {
    const { service } = build({
      cluster: { id: 'c1', provider: 'hetzner', nodes: [] },
      provider: { attachServerToVNet: jest.fn() },
    });
    await expect(service.attachClusterToVNet('c1', dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws BadRequestException when provider does not support VNet attachment (Contabo)', async () => {
    const { service } = build({
      cluster: {
        id: 'c1',
        provider: 'contabo',
        nodes: [{ id: 'n1', providerResourceId: 'srv-1' }],
        metadata: {},
      },
      provider: {}, // no attachServerToVNet method
    });
    await expect(service.attachClusterToVNet('c1', dto)).rejects.toThrow(
      /does not support VNet attachment/,
    );
  });

  it('throws ConflictException when cluster already attached to a different VNet', async () => {
    const { service } = build({
      cluster: {
        id: 'c1',
        provider: 'hetzner',
        nodes: [{ id: 'n1', providerResourceId: 'srv-1' }],
        metadata: { vnetConfig: { vnetId: 'other-vnet' } },
      },
      provider: { attachServerToVNet: jest.fn() },
    });
    await expect(service.attachClusterToVNet('c1', dto)).rejects.toThrow(
      ConflictException,
    );
  });

  it('throws BadRequestException when VNet provider differs from cluster provider', async () => {
    const { service } = build({
      cluster: {
        id: 'c1',
        provider: 'hetzner',
        nodes: [{ id: 'n1', providerResourceId: 'srv-1' }],
        metadata: {},
      },
      provider: { attachServerToVNet: jest.fn() },
      vnet: { provider: 'scaleway', subnets: [{ id: 'subnet-1' }] },
    });
    await expect(service.attachClusterToVNet('c1', dto)).rejects.toThrow(
      /belongs to provider/,
    );
  });

  it('queues an attach-cluster-to-vnet job and returns the operation on happy path', async () => {
    const cluster = {
      id: 'c1',
      name: 'prod',
      provider: 'hetzner',
      nodes: [
        { id: 'n1', providerResourceId: 'srv-1' },
        { id: 'n2', providerResourceId: 'srv-2' },
      ],
      metadata: {},
    };
    const { service, operationRepo, queue } = build({
      cluster,
      provider: { attachServerToVNet: jest.fn() },
      vnet: {
        provider: 'hetzner',
        subnets: [{ id: 'subnet-1' }],
      },
    });

    const op = await service.attachClusterToVNet('c1', dto);

    expect(operationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'attach_cluster_to_vnet',
        status: 'PENDING',
        resourceId: 'c1',
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'attach-cluster-to-vnet',
      expect.objectContaining({
        operationId: op.id,
        clusterId: 'c1',
        vnetConfig: {
          vnetId: 'vnet-1',
          subnetId: 'subnet-1',
          autoAssignIp: true,
        },
      }),
      expect.any(Object),
    );
  });

  it('is idempotent when cluster already attached to the same VNet', async () => {
    const cluster = {
      id: 'c1',
      name: 'prod',
      provider: 'hetzner',
      nodes: [{ id: 'n1', providerResourceId: 'srv-1' }],
      metadata: { vnetConfig: { vnetId: 'vnet-1', subnetId: 'subnet-1' } },
    };
    const { service, queue } = build({
      cluster,
      provider: { attachServerToVNet: jest.fn() },
      vnet: { provider: 'hetzner', subnets: [{ id: 'subnet-1' }] },
    });

    await service.attachClusterToVNet('c1', dto);
    expect(queue.add).toHaveBeenCalled();
  });
});
