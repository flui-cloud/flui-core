import { BadRequestException } from '@nestjs/common';

// vnets.service → subnet-calculator → ip-cidr → ip-address is ESM-only and jest
// can't transform it. registerManualVNet doesn't use SubnetCalculator, so stub
// the module via a factory so the import graph loads.
jest.mock('../utils/subnet-calculator', () => ({
  SubnetCalculator: { validateSubnetInRange: () => true },
}));

import { VNetsService } from './vnets.service';
import { SubnetType } from '../entities/vnet-subnet.entity';
import { VNetStatus } from '../entities/vnet.entity';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

describe('VNetsService.registerManualVNet', () => {
  function make(opts: { existing?: any } = {}) {
    const saved: any = {};
    const vnetRepo: any = {
      findOne: jest.fn().mockImplementation(({ where }: any) => {
        if (where.providerResourceId) {
          return Promise.resolve(opts.existing ?? null);
        }
        // getVNet(id) — return a well-formed entity for the mapper.
        return Promise.resolve({
          id: where.id,
          providerResourceId: 'manual:c-1',
          name: 'flui-byos-net',
          provider: CloudProvider.BYOS,
          ipRange: saved.ipRange ?? '10.89.0.0/24',
          labels: [],
          metadata: { manual: true },
          status: VNetStatus.ACTIVE,
          subnets: [
            {
              id: 'sub-1',
              vnetId: where.id,
              ipRange: saved.ipRange ?? '10.89.0.0/24',
              type: SubnetType.MANUAL,
              networkZone: 'manual',
              attachedServerIds: [],
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ],
          routes: [],
          createdAt: new Date(0),
          updatedAt: new Date(0),
        });
      }),
      create: jest.fn().mockImplementation((x: any) => x),
      save: jest.fn().mockImplementation((x: any) => {
        Object.assign(saved, x, { id: x.id ?? 'vnet-1' });
        return Promise.resolve(saved);
      }),
    };
    const subnetRepo: any = {
      create: jest.fn().mockImplementation((x: any) => x),
      save: jest.fn().mockImplementation((x: any) => Promise.resolve(x)),
    };
    const capabilitiesFactory: any = {
      getCapabilitiesService: jest.fn().mockReturnValue({
        getStaticCapabilities: () => ({
          vnetTopology: { vnetIpRange: { minPrefix: 8, maxPrefix: 30 } },
        }),
      }),
    };
    const svc = new VNetsService(
      vnetRepo,
      subnetRepo,
      {} as any,
      {} as any,
      capabilitiesFactory,
    );
    return { svc, vnetRepo, subnetRepo };
  }

  it('registers a manual VNet + one MANUAL subnet with no provider call', async () => {
    const { svc, vnetRepo, subnetRepo } = make();
    const res = await svc.registerManualVNet({
      clusterId: 'c-1',
      provider: CloudProvider.BYOS,
      name: 'flui-byos-net',
      ipRange: '10.89.0.0/24',
    });

    expect(vnetRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        providerResourceId: 'manual:c-1',
        provider: CloudProvider.BYOS,
        ipRange: '10.89.0.0/24',
        status: VNetStatus.ACTIVE,
      }),
    );
    expect(subnetRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SubnetType.MANUAL,
        ipRange: '10.89.0.0/24',
        networkZone: 'manual',
      }),
    );
    expect(res.ipRange).toBe('10.89.0.0/24');
    expect(res.subnets[0].ipRange).toBe('10.89.0.0/24');
  });

  it('rejects an invalid CIDR', async () => {
    const { svc } = make();
    await expect(
      svc.registerManualVNet({
        clusterId: 'c-1',
        provider: CloudProvider.BYOS,
        name: 'n',
        ipRange: 'not-a-cidr',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a prefix outside the provider constraints', async () => {
    const { svc } = make();
    await expect(
      svc.registerManualVNet({
        clusterId: 'c-1',
        provider: CloudProvider.BYOS,
        name: 'n',
        ipRange: '10.0.0.0/4', // below minPrefix 8
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is idempotent per cluster: re-register syncs the CIDR, no new VNet', async () => {
    const existing = {
      id: 'vnet-1',
      providerResourceId: 'manual:c-1',
      ipRange: '10.89.0.0/24',
      subnets: [
        { id: 'sub-1', type: SubnetType.MANUAL, ipRange: '10.89.0.0/24' },
      ],
    };
    const { svc, vnetRepo } = make({ existing });
    await svc.registerManualVNet({
      clusterId: 'c-1',
      provider: CloudProvider.BYOS,
      name: 'n',
      ipRange: '10.10.0.0/24',
    });
    expect(vnetRepo.create).not.toHaveBeenCalled();
    expect(vnetRepo.save).toHaveBeenCalled(); // CIDR synced on the existing VNet
    expect(existing.ipRange).toBe('10.10.0.0/24');
  });
});
