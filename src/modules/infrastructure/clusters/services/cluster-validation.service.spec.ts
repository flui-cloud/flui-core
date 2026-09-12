// cluster-validation.service.ts pulls in ManagementService, whose import graph
// reaches ESM-only packages ts-jest cannot transform (see
// clusters.controller.fence.spec.ts for the same guard) — none of them are
// exercised by these tests.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({
  __esModule: true,
  default: class {},
}));

import { ConflictException } from '@nestjs/common';
import { ClusterValidationService } from './cluster-validation.service';
import { ClusterStatus } from '../entities/cluster.entity';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

describe('ClusterValidationService.checkNameAvailability', () => {
  function build({
    existingCluster = null,
    servers = [],
    listServersAsDto = jest.fn().mockResolvedValue(servers),
  }: {
    existingCluster?: unknown;
    servers?: Array<{ name: string }>;
    listServersAsDto?: jest.Mock;
  } = {}) {
    const clusterRepo = {
      findOne: jest.fn().mockResolvedValue(existingCluster),
    };
    const managementService = {};
    const providerFactory = {
      getProvider: jest.fn().mockReturnValue({ listServersAsDto }),
    };
    const service = new ClusterValidationService(
      clusterRepo as never,
      managementService as never,
      providerFactory as never,
    );
    return { service, clusterRepo, providerFactory, listServersAsDto };
  }

  it('is unavailable when a non-deleted cluster already owns the name', async () => {
    const { service, providerFactory } = build({
      existingCluster: { id: 'c1', name: 'workload-1' },
    });

    const result = await service.checkNameAvailability(
      'workload-1',
      CloudProvider.OVH,
    );

    expect(result).toEqual({
      available: false,
      reason: "Cluster with name 'workload-1' already exists",
    });
    // The DB collision is conclusive on its own — no need to spend a provider call.
    expect(providerFactory.getProvider).not.toHaveBeenCalled();
  });

  it('is unavailable when the DB is free but the provider still has "<name>-master"', async () => {
    const { service } = build({
      existingCluster: null,
      servers: [{ name: 'workload-1-master' }],
    });

    const result = await service.checkNameAvailability(
      'workload-1',
      CloudProvider.OVH,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/workload-1-master/);
    expect(result.reason).toMatch(/ovh/i);
  });

  it('is available when neither the DB nor the provider have a collision', async () => {
    const { service } = build({ servers: [{ name: 'some-other-master' }] });

    const result = await service.checkNameAvailability(
      'workload-1',
      CloudProvider.OVH,
    );

    expect(result).toEqual({ available: true });
  });

  it('fails open (available) when the provider call errors — this is a best-effort backstop, not the only guard', async () => {
    const { service } = build({
      listServersAsDto: jest.fn().mockRejectedValue(new Error('OVH API down')),
    });

    const result = await service.checkNameAvailability(
      'workload-1',
      CloudProvider.OVH,
    );

    expect(result).toEqual({ available: true });
  });

  it('excludes soft-deleted clusters from the DB collision check', async () => {
    const { service, clusterRepo } = build();

    await service.checkNameAvailability('workload-1', CloudProvider.OVH);

    expect(clusterRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ name: 'workload-1' }),
      }),
    );
    const whereArg = clusterRepo.findOne.mock.calls[0][0].where;
    expect(whereArg.status._type).toBe('not');
    expect(whereArg.status._value).toBe(ClusterStatus.DELETED);
  });
});

describe('ClusterValidationService.validateCreateClusterRequest — name gate', () => {
  it('throws ConflictException with the availability reason when the name is taken', async () => {
    const clusterRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'c1', name: 'workload-1' }),
    };
    const providerFactory = { getProvider: jest.fn() };
    const service = new ClusterValidationService(
      clusterRepo as never,
      {} as never,
      providerFactory as never,
    );

    await expect(
      service.validateCreateClusterRequest({
        name: 'workload-1',
        provider: CloudProvider.OVH,
      } as never),
    ).rejects.toThrow(ConflictException);
  });
});
