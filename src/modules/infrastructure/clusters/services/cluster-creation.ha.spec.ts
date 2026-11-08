import { BadRequestException } from '@nestjs/common';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { ClusterCreationService } from './cluster-creation.service';
import { HaCreationPlanService } from './ha-creation-plan.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

describe('ClusterCreationService.createCluster — across three locations', () => {
  const sizes = [
    {
      id: '109',
      name: 'cpx22',
      architecture: 'x86',
      availability: ['fsn1', 'nbg1', 'hel1'].map((location) => ({
        location,
        available: true,
      })),
    },
    {
      id: '45',
      name: 'cax11',
      architecture: 'arm',
      availability: ['fsn1', 'nbg1', 'hel1'].map((location) => ({
        location,
        available: false,
      })),
    },
  ];

  function build() {
    const clusterRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: object) => x),
      save: jest.fn(async (x: object) => ({ id: 'cluster-1', ...x })),
      delete: jest.fn(),
    };
    const operationRepo = {
      create: jest.fn((x: Record<string, any>) => x),
      save: jest.fn(async (x: object) => ({ id: 'op-1', ...x })),
    };
    const envSubnet = {
      id: 'subnet-1',
      vnetId: 'vnet-1',
      ipRange: '10.10.1.0/24',
      vnet: {
        provider: CloudProvider.HETZNER,
        implementation: 'provider-native',
      },
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const getNodeSizes = jest.fn().mockResolvedValue(sizes);
    const providers = { getProvider: () => ({ getNodeSizes }) };
    const capabilitiesFactory = {
      getCapabilitiesService: () => ({
        getStaticCapabilities: () => ({
          firewall: { backend: 'managed-api' },
          vnetRequired: true,
          crossClusterAllowed: true,
        }),
        nodeTopology: (location: string) => ({
          zone: location,
          region: 'eu-central',
        }),
        haTopologies: () => [
          {
            region: 'eu-central',
            zones: ['fsn1', 'nbg1', 'hel1'],
            dataZones: ['fsn1', 'nbg1'],
            validated: true,
            measured: true,
          },
        ],
      }),
    };
    const service = new ClusterCreationService(
      clusterRepo as never,
      operationRepo as never,
      {
        findOne: jest.fn().mockResolvedValue(envSubnet),
        find: jest.fn().mockResolvedValue([envSubnet]),
      } as never,
      queue as never,
      {
        generateK3sToken: () => 'token',
        encrypt: () => 'encrypted',
      } as never,
      {
        createAndReconcileFirewall: jest.fn().mockResolvedValue('fw-1'),
      } as never,
      capabilitiesFactory as never,
      { resolveControlEgressIps: jest.fn().mockResolvedValue([]) } as never,
      new ManagementAddressResolver(),
      {} as never,
      providers as never,
      new HaCreationPlanService(
        capabilitiesFactory as never,
        providers as never,
      ),
    );
    return { service, clusterRepo, operationRepo, queue, getNodeSizes };
  }

  const dto = {
    name: 'ha-hz',
    provider: CloudProvider.HETZNER,
    region: 'fsn1',
    nodeSize: 'cpx22',
    workerCount: 0,
    highAvailability: 'three-locations' as const,
  };

  it('records the servers it will buy, with live availability, before queueing the creation', async () => {
    const { service, clusterRepo, operationRepo, queue, getNodeSizes } =
      build();

    await service.createCluster(dto as never);

    expect(getNodeSizes).toHaveBeenCalledWith(true);
    expect(clusterRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeSize: 'cpx22',
        metadata: expect.objectContaining({
          highAvailability: 'three-locations',
        }),
      }),
    );
    const operation = operationRepo.create.mock.calls[0][0];
    expect(operation.metadata.haPlan).toEqual({
      region: 'eu-central',
      first: { zone: 'fsn1', shape: 'cpx22' },
      servers: [
        { zone: 'nbg1', shape: 'cpx22' },
        { zone: 'hel1', shape: 'cpx22' },
      ],
      later: [],
    });
    expect(operation.metadata.operationSteps[3].description).toBe(
      'Joining the servers in nbg1 and hel1, one at a time',
    );
    expect(queue.add).toHaveBeenCalledWith(
      'create-cluster',
      expect.anything(),
      expect.anything(),
    );
  });

  it('buys nothing and saves nothing when a location has none of the sizes', async () => {
    const { service, clusterRepo, queue } = build();

    await expect(
      service.createCluster({ ...dto, nodeSize: 'cax11' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(clusterRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('previews the servers with their role, and buys nothing', async () => {
    const { service, clusterRepo, queue } = build();

    const plan = await service.previewHighAvailability({
      provider: CloudProvider.HETZNER,
      region: 'fsn1',
      shapes: ['cpx22'],
      completeLater: false,
    });

    expect(plan).toEqual({
      layoutAvailable: true,
      possible: true,
      refusal: null,
      completeLaterHelps: false,
      region: 'eu-central',
      measured: true,
      servers: [
        { zone: 'fsn1', shape: 'cpx22', role: 'data', first: true },
        { zone: 'nbg1', shape: 'cpx22', role: 'data', first: false },
        { zone: 'hel1', shape: 'cpx22', role: 'vote', first: false },
      ],
      later: [],
    });
    expect(clusterRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('previews a refusal with the layout still on offer', async () => {
    const { service } = build();

    const plan = await service.previewHighAvailability({
      provider: CloudProvider.HETZNER,
      region: 'fsn1',
      shapes: ['cax11'],
      completeLater: false,
    });

    expect(plan).toMatchObject({
      layoutAvailable: true,
      possible: false,
      completeLaterHelps: false,
    });
    expect(plan.refusal).toBe(
      'fsn1, nbg1 and hel1 have none of cax11 available now. No arm size is available in all three locations right now.',
    );
  });

  it('leaves a standard cluster as it always was', async () => {
    const { service, operationRepo, getNodeSizes } = build();

    await service.createCluster({
      ...dto,
      highAvailability: undefined,
    } as never);

    expect(getNodeSizes).not.toHaveBeenCalledWith(true);
    expect(
      operationRepo.create.mock.calls[0][0].metadata.haPlan,
    ).toBeUndefined();
  });
});
