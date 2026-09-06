jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterQueueProcessor } from './cluster-queue.processor';
import { ReconciliationStatus } from '../../shared/enums/reconciliation-status.enum';

/**
 * A ready cluster is not a ready platform. Measured on workload-cluster-4: the
 * cluster reported ready at 2m19s and the hook fired at once, but cert-manager
 * had not yet registered its DNS-01 webhook — so the pass failed with "webhook
 * not installed" and no ClusterIssuer was ever created. One retry, twenty
 * minutes later, reached IN_SYNC in ten seconds.
 */
describe('ClusterQueueProcessor, reconciling zones once the cluster is up', () => {
  function make(outcomes: (string | Error)[]) {
    const processor = Object.create(
      ClusterQueueProcessor.prototype,
    ) as ClusterQueueProcessor;
    const r = processor as unknown as Record<string, unknown>;
    let call = 0;
    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.clusterDnsZoneService = {
      getZonesForCluster: jest.fn(async () => [{ id: 'a-1' }]),
      reconcileAssignment: jest.fn(async () => {
        const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
        if (outcome instanceof Error) throw outcome;
        return {
          id: 'a-1',
          reconciliationStatus: outcome,
          errorMessage:
            outcome === ReconciliationStatus.ERROR ? 'webhook' : null,
        };
      }),
    };
    const attempts = () =>
      (
        r.clusterDnsZoneService as {
          reconcileAssignment: jest.Mock;
        }
      ).reconcileAssignment.mock.calls.length;
    const run = async () => {
      jest.useFakeTimers();
      const running = (
        processor as unknown as {
          reconcileZoneAssignments(c: unknown): Promise<void>;
        }
      ).reconcileZoneAssignments({ id: 'c-1' });
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      await running;
      jest.useRealTimers();
    };
    return { run, attempts };
  }

  it('tries again when the component it needs has not come up yet', async () => {
    const h = make([
      ReconciliationStatus.ERROR,
      ReconciliationStatus.ERROR,
      ReconciliationStatus.IN_SYNC,
    ]);

    await h.run();

    expect(h.attempts()).toBe(3);
  });

  it('stops as soon as it settles', async () => {
    const h = make([ReconciliationStatus.IN_SYNC]);

    await h.run();

    expect(h.attempts()).toBe(1);
  });

  it('gives up rather than retrying a genuinely broken cluster forever', async () => {
    const h = make([ReconciliationStatus.ERROR]);

    await h.run();

    expect(h.attempts()).toBe(5);
  });

  it('keeps trying when a pass throws instead of returning', async () => {
    const h = make([new Error('boom'), ReconciliationStatus.IN_SYNC]);

    await h.run();

    expect(h.attempts()).toBe(2);
  });
});
