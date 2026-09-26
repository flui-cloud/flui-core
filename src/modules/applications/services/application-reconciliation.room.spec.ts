jest.mock('@kubernetes/client-node', () => ({}));

import { ApplicationReconciliationService } from './application-reconciliation.service';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';

const pendingForRoom = {
  metadata: { name: 'probe-a' },
  status: {
    phase: 'Pending',
    conditions: [
      {
        type: 'PodScheduled',
        status: 'False',
        reason: 'Unschedulable',
        message: '0/1 nodes are available: 1 Insufficient memory.',
      },
    ],
  },
};
const running = {
  metadata: { name: 'probe-b' },
  status: { phase: 'Running', containerStatuses: [{ ready: true }] },
};

async function reconcile(pods: unknown[], readyReplicas: number) {
  const release = { markCurrentReleaseFailed: jest.fn(async () => null) };
  const app = {
    id: 'app-1',
    name: 'probe',
    slug: 'probe',
    clusterId: 'c1',
    k8sNamespace: 'ns',
    status: ApplicationStatus.PROVISIONING,
    category: 'user',
    metadata: {},
  };
  const service = new (ApplicationReconciliationService as unknown as new (
    ...args: unknown[]
  ) => ApplicationReconciliationService)(
    { findOne: async () => ({ id: 'c1', kubeconfigEncrypted: 'enc' }) },
    {
      getResource: async () => ({
        metadata: { resourceVersion: '1', annotations: {} },
        spec: { replicas: 2 },
        status: {
          readyReplicas,
          replicas: 2,
          unavailableReplicas: 2 - readyReplicas,
          conditions: [
            {
              type: 'Progressing',
              status: 'False',
              reason: 'ProgressDeadlineExceeded',
            },
          ],
        },
      }),
      listPodsByLabel: async () => pods,
    },
    { decrypt: () => 'kubeconfig' },
    {
      findById: async () => app,
      update: async () => app,
    },
    {
      findByApplicationId: async () => [
        {
          id: 'res-1',
          kind: 'Deployment',
          name: 'probe',
          namespace: 'ns',
          metadata: {},
        },
      ],
      update: async () => undefined,
      findById: async () => ({
        id: 'res-1',
        status: ApplicationResourceStatus.DEGRADED,
        reconciliationStatus: 'IN_SYNC',
      }),
    },
    undefined,
    release,
  );
  const summary = await service.reconcileOne('app-1');
  return { summary, release };
}

describe('an application whose replicas wait for a node with room', () => {
  it('is waiting for room, not degraded, when it never started — and no release is failed', async () => {
    const { summary, release } = await reconcile([pendingForRoom], 0);
    expect(summary.newStatus).toBe(ApplicationStatus.WAITING_FOR_ROOM);
    expect(release.markCurrentReleaseFailed).not.toHaveBeenCalled();
  });

  it('is running when it serves and only extra replicas wait', async () => {
    const { summary } = await reconcile([running, pendingForRoom], 1);
    expect(summary.newStatus).toBe(ApplicationStatus.RUNNING);
  });

  it('stays degraded when nothing waits for room', async () => {
    const { summary } = await reconcile([running], 1);
    expect(summary.newStatus).not.toBe(ApplicationStatus.WAITING_FOR_ROOM);
  });
});
