jest.mock('@kubernetes/client-node', () => ({}));

import { ApplicationReconciliationService } from './application-reconciliation.service';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';
import { ENDPOINT_FAILURE_METADATA_KEY } from '../utils/endpoint-failure.util';

/**
 * The other half of the endpoint repair, and the reason it needed a fact on the
 * row rather than a status written once.
 *
 * The reconciler derives an application's status from its Kubernetes resources,
 * and the pods of a public application nobody can reach are in perfect health —
 * so the FAILED verdict the deploy writes would be back to `running` at the
 * first refresh of the applications list, and the dashboard would again show
 * green for something answering 404 on every host.
 */
describe('ApplicationReconciliationService — an application with no endpoint it was owed', () => {
  const REASON =
    'exposure: public, but no public endpoint could be created — Cluster cluster-4 has no master IP yet. The application is running and unreachable from outside.';

  const run = async (metadata: Record<string, unknown>) => {
    const updates: Array<Record<string, unknown>> = [];
    const app = {
      id: 'app-1',
      name: 'flui-apply-probe',
      slug: 'flui-apply-probe-883q7r',
      clusterId: 'cluster-4',
      status: ApplicationStatus.RUNNING,
      category: 'user',
      metadata,
    };

    const service = new (ApplicationReconciliationService as unknown as new (
      ...args: unknown[]
    ) => ApplicationReconciliationService)(
      {
        findOne: async () => ({ id: 'cluster-4', kubeconfigEncrypted: 'enc' }),
      },
      {
        // Every read the cycle makes — readiness, stuck-rollout, health — goes
        // through this one call, and it answers with a healthy Deployment.
        getResource: async () => ({
          metadata: { resourceVersion: '1', annotations: {} },
          spec: { replicas: 1 },
          status: { readyReplicas: 1, replicas: 1, conditions: [] },
        }),
      },
      { decrypt: () => 'kubeconfig' },
      {
        findById: async () => app,
        update: async (_id: string, patch: Record<string, unknown>) => {
          updates.push(patch);
          return app;
        },
      },
      {
        findByApplicationId: async () => [
          {
            id: 'res-1',
            kind: 'Deployment',
            name: 'flui-apply-probe-883q7r',
            namespace: 'ns',
            metadata: {},
          },
        ],
        update: async () => undefined,
        findById: async () => ({
          id: 'res-1',
          status: ApplicationResourceStatus.READY,
          reconciliationStatus: 'IN_SYNC',
        }),
      },
      undefined,
      { markCurrentReleaseFailed: async () => null },
    );

    const summary = await service.reconcileOne('app-1');
    return { summary, final: updates[updates.length - 1] };
  };

  it('keeps saying so, instead of reading the pods and calling it running', async () => {
    const { summary, final } = await run({
      [ENDPOINT_FAILURE_METADATA_KEY]: REASON,
    });

    expect(summary.newStatus).toBe(ApplicationStatus.FAILED);
    expect(final.status).toBe(ApplicationStatus.FAILED);
    expect(final.reconciliationError).toContain('no public endpoint');
  });

  it('says running for the same healthy pods once nothing is owed', async () => {
    const { summary, final } = await run({});

    expect(summary.newStatus).toBe(ApplicationStatus.RUNNING);
    expect(final.status).toBe(ApplicationStatus.RUNNING);
    expect(final.reconciliationError).toBeNull();
  });
});
