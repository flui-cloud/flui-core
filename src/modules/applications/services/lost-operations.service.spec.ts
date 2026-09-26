jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { LostOperationsService } from './lost-operations.service';
import { ApplicationStatus } from '../enums/application-status.enum';
import { OperationStatus } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { LOST_OPERATION_MESSAGE } from '../utils/lost-operations.core';

const old = new Date(Date.now() - 10 * 60_000);

function build(opts: {
  inFlight: Array<{ id: string }>;
  queued: string[];
  orphaned?: boolean;
}) {
  const operations = {
    find: jest
      .fn()
      .mockResolvedValue(
        opts.inFlight.map((o) => ({ ...o, createdAt: old, updatedAt: old })),
      ),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const queue = {
    getJobs: jest
      .fn()
      .mockResolvedValue(
        opts.queued.map((operationId) => ({ data: { operationId } })),
      ),
  };
  const applications = {
    isOrphanedUpdate: jest.fn().mockResolvedValue(opts.orphaned ?? false),
  };
  const reconciliation = { reconcileOne: jest.fn().mockResolvedValue({}) };
  const service = new LostOperationsService(
    operations as never,
    queue as never,
    applications as never,
    reconciliation as never,
  );
  return { service, operations, reconciliation };
}

describe('LostOperationsService', () => {
  it('fails the operations no job carries, and only those', async () => {
    const t = build({
      inFlight: [{ id: 'lost' }, { id: 'live' }],
      queued: ['live'],
    });
    expect(await t.service.closeLost()).toBe(1);
    expect(t.operations.update).toHaveBeenCalledTimes(1);
    expect(t.operations.update).toHaveBeenCalledWith(
      'lost',
      expect.objectContaining({
        status: OperationStatus.FAILED,
        errorMessage: LOST_OPERATION_MESSAGE,
      }),
    );
  });

  it('reads an app from the cluster when it says updating with nothing behind it', async () => {
    const t = build({ inFlight: [], queued: [], orphaned: true });
    await t.service.settle('app-1', ApplicationStatus.UPDATING);
    expect(t.reconciliation.reconcileOne).toHaveBeenCalledWith('app-1');
  });

  it('leaves an app alone while its deploy is still running', async () => {
    const t = build({ inFlight: [], queued: [], orphaned: false });
    await t.service.settle('app-1', ApplicationStatus.UPDATING);
    expect(t.reconciliation.reconcileOne).not.toHaveBeenCalled();
  });

  it('asks nothing of an app that is not updating', async () => {
    const t = build({ inFlight: [{ id: 'x' }], queued: [] });
    await t.service.settle('app-1', ApplicationStatus.RUNNING);
    expect(t.operations.find).not.toHaveBeenCalled();
  });
});
