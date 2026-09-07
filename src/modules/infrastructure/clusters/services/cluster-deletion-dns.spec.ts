jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterDeletionService } from './cluster-deletion.service';

/**
 * The label sweep matches on `flui-cluster-id`/`managed-by`, and `*.<cluster>`
 * was published without them until today — so destroying a cluster left its
 * wildcard answering with a released address, and a later cluster taking that
 * name found its own wildcard already occupied. Withdrawing by value covers the
 * records that predate the labels too.
 */
describe('ClusterDeletionService, the wildcard a destroyed cluster leaves', () => {
  function make(opts: { assignments?: unknown[]; retractThrows?: boolean }) {
    const service = Object.create(
      ClusterDeletionService.prototype,
    ) as ClusterDeletionService;
    const r = service as unknown as Record<string, unknown>;
    const order: string[] = [];

    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.zoneAssignmentRepository = {
      find: jest.fn(
        async () =>
          opts.assignments ?? [
            { id: 'a-1', dnsZone: { zoneName: 'example.com' } },
          ],
      ),
    };
    r.zoneReconciliation = {
      retractClusterWildcardRecord: jest.fn(async () => {
        order.push('retract');
        if (opts.retractThrows) throw new Error('provider unreachable');
        return { status: 'absent' };
      }),
    };
    r.clusterDnsCleanupService = {
      deleteRecordsByClusterId: jest.fn(async () => {
        order.push('labels');
        return 2;
      }),
    };
    return { service, order, r };
  }

  it('withdraws the wildcard before sweeping what carries labels', async () => {
    const h = make({});

    await h.service.cleanupClusterDnsRecords('c-1');

    expect(h.order).toEqual(['retract', 'labels']);
  });

  it('skips an assignment with no zone rather than guessing', async () => {
    const h = make({ assignments: [{ id: 'a-1', dnsZone: null }] });

    await h.service.cleanupClusterDnsRecords('c-1');

    expect(
      (h.r.zoneReconciliation as { retractClusterWildcardRecord: jest.Mock })
        .retractClusterWildcardRecord,
    ).not.toHaveBeenCalled();
  });

  it('still deletes the cluster when the DNS provider is unreachable', async () => {
    // The record matters less than the deletion completing.
    const h = make({ retractThrows: true });

    await expect(
      h.service.cleanupClusterDnsRecords('c-1'),
    ).resolves.toBeUndefined();
    expect(h.order).toContain('labels');
  });
});
