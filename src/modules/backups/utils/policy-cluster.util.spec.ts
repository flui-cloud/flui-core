import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  policyClusterVerdict,
  retiredForGoneCluster,
} from './policy-cluster.util';

describe('what a due backup policy does about its cluster', () => {
  it('retires for a deleted, soft-deleted or vanished cluster', () => {
    expect(policyClusterVerdict(null)).toBe('retire');
    expect(policyClusterVerdict({ status: ClusterStatus.DELETED })).toBe(
      'retire',
    );
    expect(
      policyClusterVerdict({
        status: ClusterStatus.READY,
        deletedAt: new Date(),
      }),
    ).toBe('retire');
  });

  it('only skips for a lost cluster, and runs for a live one', () => {
    expect(policyClusterVerdict({ status: ClusterStatus.LOST })).toBe('skip');
    expect(policyClusterVerdict({ status: ClusterStatus.READY })).toBe('run');
  });

  it('recognises a policy retired for that reason', () => {
    expect(
      retiredForGoneCluster({ metadata: { pausedReason: 'cluster_gone' } }),
    ).toBe(true);
    expect(retiredForGoneCluster({ metadata: {} })).toBe(false);
    expect(retiredForGoneCluster({})).toBe(false);
  });
});
