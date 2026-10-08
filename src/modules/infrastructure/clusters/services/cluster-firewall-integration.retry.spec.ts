jest.mock('@kubernetes/client-node', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { ClusterFirewallIntegrationService } from './cluster-firewall-integration.service';

function setup(existing: { id: string } | null) {
  const desired = {
    getFirewallByClusterId: jest.fn(async () => {
      if (!existing) throw new NotFoundException();
      return existing;
    }),
    createFirewall: jest.fn(async () => ({ id: 'fw-new' })),
  };
  const reconciliation = {
    enableHostLayerAtCreation: jest.fn(async () => undefined),
    reconcile: jest.fn(async (id: string) => ({
      id,
      providerFirewallId: `nft-${id}`,
    })),
  };
  const service = new ClusterFirewallIntegrationService(
    desired as never,
    reconciliation as never,
  );
  return { service, desired, reconciliation };
}

describe('the firewall a cluster is created with', () => {
  it('is created on the first attempt', async () => {
    const { service, desired } = setup(null);
    await expect(
      service.createAndReconcileFirewall({ id: 'c1' } as never, []),
    ).resolves.toBe('nft-fw-new');
    expect(desired.createFirewall).toHaveBeenCalled();
  });

  it('is the one already recorded when the creation is retried', async () => {
    const { service, desired, reconciliation } = setup({ id: 'fw-1' });
    await expect(
      service.createAndReconcileFirewall({ id: 'c1' } as never, []),
    ).resolves.toBe('nft-fw-1');
    expect(desired.createFirewall).not.toHaveBeenCalled();
    expect(reconciliation.reconcile).toHaveBeenCalledWith('fw-1');
  });
});
