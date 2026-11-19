import { ClusterStatus } from '../entities/cluster.entity';
import { beingDestroyed } from './cluster-lifecycle.util';

describe('a cluster being destroyed', () => {
  it('is one asked to go, whether it is still going or already gone', () => {
    expect(beingDestroyed({ status: ClusterStatus.DELETING })).toBe(true);
    expect(beingDestroyed({ status: ClusterStatus.DELETION_FAILED })).toBe(
      true,
    );
    expect(beingDestroyed({ status: ClusterStatus.DELETED })).toBe(true);
    expect(
      beingDestroyed({ status: ClusterStatus.READY, deletedAt: new Date() }),
    ).toBe(true);
  });

  it('is not one that serves, or one still being created', () => {
    expect(beingDestroyed({ status: ClusterStatus.READY })).toBe(false);
    expect(beingDestroyed({ status: ClusterStatus.CREATING })).toBe(false);
  });
});
