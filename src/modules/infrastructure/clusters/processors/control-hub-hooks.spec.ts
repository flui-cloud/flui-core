import { Logger } from '@nestjs/common';
import {
  joinControlHub,
  leaveControlHub,
  operationWarnings,
} from './control-hub-hooks';
import { ControlMembershipService } from '../../networking/services/control-membership.service';
import { ClusterType } from '../entities/cluster.entity';

const logger = { warn: jest.fn() } as unknown as Logger;

const refWith = (service: Partial<ControlMembershipService>) =>
  ({
    get: (token: unknown) =>
      token === ControlMembershipService ? service : undefined,
  }) as any;

describe('control workers join and leave the Flui network with their operation', () => {
  it('converges the hub after a worker joins the control cluster', async () => {
    const afterControlNodesJoined = jest.fn().mockResolvedValue([]);
    const warnings = await joinControlHub(
      { id: 'ctl', clusterType: ClusterType.CONTROL } as any,
      refWith({ afterControlNodesJoined }),
      logger,
    );
    expect(afterControlNodesJoined).toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it('leaves a workload cluster’s workers to the regular sweep', async () => {
    const afterControlNodesJoined = jest.fn();
    await joinControlHub(
      { id: 'wl', clusterType: ClusterType.WORKLOAD } as any,
      refWith({ afterControlNodesJoined }),
      logger,
    );
    expect(afterControlNodesJoined).not.toHaveBeenCalled();
  });

  it('turns what did not converge into a warning on the operation, never a failure', async () => {
    const warnings = await joinControlHub(
      { id: 'ctl', clusterType: ClusterType.CONTROL } as any,
      refWith({
        afterControlNodesJoined: jest
          .fn()
          .mockRejectedValue(new Error('ssh timeout')),
      }),
      logger,
    );
    expect(warnings).toEqual([
      { code: 'CONTROL_HUB_NOT_CONVERGED', reason: 'ssh timeout' },
    ]);
  });

  it('withdraws a control worker before it is deleted', async () => {
    const beforeControlNodeRemoved = jest
      .fn()
      .mockResolvedValue(['demo/9.9.9.9: ssh timeout']);
    const warnings = await leaveControlHub(
      { id: 'ctl', clusterType: ClusterType.CONTROL } as any,
      'worker-1',
      refWith({ beforeControlNodeRemoved }),
      logger,
    );
    expect(beforeControlNodeRemoved).toHaveBeenCalledWith('worker-1');
    expect(warnings[0].reason).toContain('demo/9.9.9.9');
  });

  it('does nothing without the networking module', async () => {
    expect(
      await leaveControlHub(
        { id: 'ctl', clusterType: ClusterType.CONTROL } as any,
        'w',
        undefined,
        logger,
      ),
    ).toEqual([]);
  });
});

describe('what an add-worker operation completes with', () => {
  const admission = { code: 'CONTROL_TUNNEL_ADMISSION', message: 'later' };

  it('carries what the hub did not converge on as warnings, after the admission', async () => {
    const hub = await joinControlHub(
      { id: 'ctl', clusterType: ClusterType.CONTROL } as any,
      refWith({
        afterControlNodesJoined: jest
          .fn()
          .mockResolvedValue(['control node 2.2.2.2: cannot run WireGuard']),
      }),
      logger,
    );
    expect(operationWarnings(admission, hub)).toEqual([
      admission,
      {
        code: 'CONTROL_HUB_NOT_CONVERGED',
        message: 'control node 2.2.2.2: cannot run WireGuard',
      },
    ]);
  });

  it('is empty when nothing needs saying', () => {
    expect(operationWarnings(null, [])).toEqual([]);
  });
});
