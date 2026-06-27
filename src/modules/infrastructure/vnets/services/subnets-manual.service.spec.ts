import { BadRequestException } from '@nestjs/common';
import { SubnetsService } from './subnets.service';
import { SubnetType } from '../entities/vnet-subnet.entity';

describe('SubnetsService — manual (BYOS) subnet', () => {
  function make(subnet: any) {
    const subnetRepo: any = {
      findOne: jest.fn().mockResolvedValue(subnet),
      save: jest.fn().mockImplementation((x: any) => Promise.resolve(x)),
    };
    const providerFactory: any = {
      getProvider: jest.fn(() => {
        throw new Error('provider must not be called for a manual subnet');
      }),
    };
    const svc = new SubnetsService(subnetRepo, {} as any, providerFactory);
    return { svc, subnetRepo, providerFactory };
  }

  const manualSubnet = (over: Partial<any> = {}) => ({
    id: 'sub-1',
    vnetId: 'vnet-1',
    ipRange: '10.89.0.0/24',
    type: SubnetType.MANUAL,
    networkZone: 'manual',
    attachedServerIds: [] as string[],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    vnet: { provider: 'byos' },
    ...over,
  });

  it('attaches a node by recording it — no provider call', async () => {
    const subnet = manualSubnet();
    const { svc, subnetRepo, providerFactory } = make(subnet);
    await svc.attachServerToSubnet('sub-1', {
      serverId: 'node-1',
      ip: '10.89.0.5',
    } as any);
    expect(providerFactory.getProvider).not.toHaveBeenCalled();
    expect(subnet.attachedServerIds).toContain('node-1');
    expect(subnetRepo.save).toHaveBeenCalled();
  });

  it('rejects a node IP outside the declared private network', async () => {
    const { svc } = make(manualSubnet());
    await expect(
      svc.attachServerToSubnet('sub-1', {
        serverId: 'node-1',
        ip: '10.99.0.5',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is idempotent — attaching the same node twice keeps one entry', async () => {
    const subnet = manualSubnet({ attachedServerIds: ['node-1'] });
    const { svc } = make(subnet);
    await svc.attachServerToSubnet('sub-1', {
      serverId: 'node-1',
      ip: '10.89.0.5',
    } as any);
    expect(subnet.attachedServerIds).toEqual(['node-1']);
  });

  it('detaches from a manual subnet without a provider call', async () => {
    const subnet = manualSubnet({ attachedServerIds: ['node-1', 'node-2'] });
    const { svc, providerFactory } = make(subnet);
    await svc.detachServerFromSubnet('sub-1', { serverId: 'node-1' } as any);
    expect(providerFactory.getProvider).not.toHaveBeenCalled();
    expect(subnet.attachedServerIds).toEqual(['node-2']);
  });
});
