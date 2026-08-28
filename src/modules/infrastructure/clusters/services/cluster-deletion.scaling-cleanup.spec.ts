// The service reaches the VNet maths through its neighbours, and that pulls in
// an ESM-only CIDR package ts-jest cannot transform. Nothing here calls it.
jest.mock('ip-cidr', () => ({}));
jest.mock('@kubernetes/client-node', () => ({}));

import { Repository } from 'typeorm';
import { ClusterDeletionService } from './cluster-deletion.service';
import { ScalingGroupEntity } from '../../scaling/entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../../scaling/entities/scaling-decision.entity';

/**
 * A cluster that goes away takes its scaling groups with it.
 *
 * Neither table carries a foreign key, so nothing removes them on its own — and
 * an orphaned group is not an error anybody would notice: the loop skips a group
 * whose cluster is missing, and the overview lists clusters rather than groups,
 * so it never appears anywhere. It just accumulates.
 */
function harness(groups = 1, decisions = 16) {
  const scalingGroups = {
    delete: jest.fn().mockResolvedValue({ affected: groups }),
  };
  const scalingDecisions = {
    delete: jest.fn().mockResolvedValue({ affected: decisions }),
  };

  const service = new ClusterDeletionService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    scalingGroups as unknown as Repository<ScalingGroupEntity>,
    scalingDecisions as unknown as Repository<ScalingDecisionEntity>,
  );
  return { service, scalingGroups, scalingDecisions };
}

describe('what a deleted cluster takes with it', () => {
  it('removes the scaling groups of that cluster, and only that cluster', async () => {
    const h = harness();

    await h.service.cleanupClusterScalingGroups('c-1');

    expect(h.scalingGroups.delete).toHaveBeenCalledWith({ clusterId: 'c-1' });
  });

  it('takes the decisions too, as deleting a group already does', async () => {
    const h = harness();

    await h.service.cleanupClusterScalingGroups('c-1');

    expect(h.scalingDecisions.delete).toHaveBeenCalledWith({
      clusterId: 'c-1',
    });
  });

  it('says nothing about a cluster that had none', async () => {
    const h = harness(0, 0);
    const logged = jest
      .spyOn(
        (h.service as unknown as { logger: { log: (m: string) => void } })
          .logger,
        'log',
      )
      .mockImplementation(() => undefined);

    await h.service.cleanupClusterScalingGroups('c-1');

    expect(logged).not.toHaveBeenCalled();
  });
});
