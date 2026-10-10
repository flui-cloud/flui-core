jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('@kubernetes/client-node', () => ({}));

import { SandboxSchedulerService } from './sandbox-scheduler.service';

describe('sandbox clocks when their cluster is gone', () => {
  const make = (available: boolean) => {
    const reserve = { missing: jest.fn(), build: jest.fn() };
    const capacity = {
      clusterAvailable: jest.fn(async () => available),
      missing: jest.fn(async () => 0),
      snapshot: jest.fn(),
    };
    const tenants = {
      sweepExpiredWorkloads: jest.fn(),
      reapExpired: jest.fn(async () => []),
    };
    const prepull = { warm: jest.fn(async () => []) };
    const alert = { check: jest.fn() };
    const quotas = { applyCeilings: jest.fn() };
    const service = new SandboxSchedulerService(
      reserve as any,
      capacity as any,
      tenants as any,
      prepull as any,
      alert as any,
      quotas as any,
      { enabled: true, clusterId: 'gone-1' } as any,
      { offerFreedSlots: async () => 0 } as any,
    );
    return { service, tenants, capacity, prepull };
  };

  it('does not touch a deleted cluster, and says so once', async () => {
    const { service, tenants, capacity } = make(false);
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    await service.sweepWorkloads();
    await service.refillReserve();
    await service.sweepWorkloads();
    expect(tenants.sweepExpiredWorkloads).not.toHaveBeenCalled();
    expect(capacity.missing).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('works as before on a live cluster', async () => {
    const { service, tenants } = make(true);
    await service.sweepWorkloads();
    expect(tenants.sweepExpiredWorkloads).toHaveBeenCalled();
  });
});
