import { BadRequestException } from '@nestjs/common';
import { ClusterCreationService } from './cluster-creation.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

describe('ClusterCreationService.createCluster — provider policies', () => {
  function build({
    capabilities,
    observabilityCluster,
    envVnetProvider = CloudProvider.HETZNER,
  }: {
    capabilities: { vnetRequired: boolean; crossClusterAllowed: boolean };
    observabilityCluster?: unknown;
    envVnetProvider?: CloudProvider;
  }) {
    const clusterRepo = {
      findOne: jest.fn().mockResolvedValue(observabilityCluster ?? null),
      create: jest.fn((x: object) => x),
      save: jest.fn(async (x: object) => ({ id: 'cluster-1', ...x })),
      delete: jest.fn(),
    };
    const operationRepo = {
      create: jest.fn((x: object) => x),
      save: jest.fn(async (x: object) => ({ id: 'op-1', ...x })),
    };
    // The env subnet lives on the CONTROL's provider; the service compares its
    // vnet.provider against the workload's to detect cross-provider creation.
    const vnetSubnetRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'subnet-1',
        vnetId: 'vnet-1',
        ipRange: '10.10.1.0/24',
        vnet: { provider: envVnetProvider },
      }),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const encryption = {
      generateK3sToken: jest.fn().mockReturnValue('token'),
      encrypt: jest.fn().mockReturnValue('encrypted'),
    };
    const firewallIntegration = {
      createAndReconcileFirewall: jest.fn().mockResolvedValue('fw-1'),
    };
    const capabilitiesFactory = {
      getCapabilitiesService: jest.fn().mockReturnValue({
        getStaticCapabilities: jest.fn().mockReturnValue(capabilities),
      }),
    };
    const service = new ClusterCreationService(
      clusterRepo as never,
      operationRepo as never,
      vnetSubnetRepo as never,
      queue as never,
      encryption as never,
      firewallIntegration as never,
      capabilitiesFactory as never,
    );
    return { service, firewallIntegration };
  }

  const baseDto = {
    name: 'workload-1',
    provider: CloudProvider.HETZNER,
    region: 'fsn1',
    nodeSize: 'cx22',
    workerCount: 1,
  };

  it('rejects a workload whose provider differs from the control cluster when crossClusterAllowed is false', async () => {
    const { service } = build({
      capabilities: { vnetRequired: true, crossClusterAllowed: false },
      observabilityCluster: { provider: CloudProvider.SCALEWAY },
      envVnetProvider: CloudProvider.SCALEWAY,
    });

    // Policy error wins over VNET_REQUIRED: pointing the user at a missing VNet
    // when cross-provider is banned outright would be a dead end.
    await expect(service.createCluster(baseDto as never)).rejects.toMatchObject(
      {
        response: { code: 'CROSS_PROVIDER_NOT_ALLOWED' },
      },
    );
  });

  it('allows a workload matching the control cluster provider', async () => {
    const { service, firewallIntegration } = build({
      capabilities: { vnetRequired: true, crossClusterAllowed: false },
      observabilityCluster: { provider: CloudProvider.HETZNER },
    });

    await service.createCluster(baseDto as never);

    expect(firewallIntegration.createAndReconcileFirewall).toHaveBeenCalled();
  });

  it('allows cross-provider when crossClusterAllowed is true (workload brings its own VNet)', async () => {
    const { service, firewallIntegration } = build({
      capabilities: { vnetRequired: true, crossClusterAllowed: true },
      observabilityCluster: { provider: CloudProvider.SCALEWAY },
      envVnetProvider: CloudProvider.SCALEWAY,
    });

    // A cross-provider workload can't join the control's env subnet; it must
    // supply a VNet on its own provider.
    await service.createCluster({
      ...baseDto,
      vnetConfig: { vnetId: 'vnet-h', subnetId: 'subnet-h' },
    } as never);

    expect(firewallIntegration.createAndReconcileFirewall).toHaveBeenCalled();
  });

  it('rejects with BadRequestException', async () => {
    const { service } = build({
      capabilities: { vnetRequired: true, crossClusterAllowed: false },
      observabilityCluster: { provider: CloudProvider.SCALEWAY },
      envVnetProvider: CloudProvider.SCALEWAY,
    });

    await expect(service.createCluster(baseDto as never)).rejects.toThrow(
      BadRequestException,
    );
  });
});
