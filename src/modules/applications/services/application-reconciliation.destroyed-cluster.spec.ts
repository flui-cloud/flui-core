jest.mock('@kubernetes/client-node', () => ({}));

import { ApplicationReconciliationService } from './application-reconciliation.service';
import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';

function build(cluster: object) {
  const kubernetes = { getResource: jest.fn(), listPodsByLabel: jest.fn() };
  const applications = { findObservableByCluster: jest.fn(async () => []) };
  const service = new (ApplicationReconciliationService as unknown as new (
    ...args: unknown[]
  ) => ApplicationReconciliationService)(
    { findOne: async () => cluster },
    kubernetes,
    { decrypt: () => 'kubeconfig' },
    applications,
    {},
    undefined,
    {},
  );
  return { service, applications };
}

describe('reconciling the applications of a destroyed cluster', () => {
  it('leaves them alone, instead of waiting on a cluster that is gone', async () => {
    const { service, applications } = build({
      id: 'c1',
      kubeconfigEncrypted: 'enc',
      status: ClusterStatus.DELETED,
      deletedAt: new Date('2026-11-19T19:56:00Z'),
    });

    await service.reconcileByClusterId('c1');

    expect(applications.findObservableByCluster).not.toHaveBeenCalled();
  });

  it('still reads a cluster that is ready', async () => {
    const { service, applications } = build({
      id: 'c1',
      kubeconfigEncrypted: 'enc',
      status: ClusterStatus.READY,
    });

    await service.reconcileByClusterId('c1');

    expect(applications.findObservableByCluster).toHaveBeenCalledWith('c1');
  });
});
