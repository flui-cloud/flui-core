import {
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { NodeStatus } from '../entities/cluster-node.entity';
import { LostNodeOperationsService } from './lost-node-operations.service';
import { lostNodeOperationMessage } from './lost-node-operations.core';

const LONG_AGO = new Date('2026-10-17T08:28:00Z');
const NOW = new Date('2026-10-20T14:00:00Z');

function build(opts: {
  ops: Array<Record<string, unknown>>;
  liveIds?: string[];
  node?: Record<string, unknown> | null;
  uncordonFails?: boolean;
}) {
  const operations = {
    find: jest.fn().mockResolvedValue(opts.ops),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const queue = {
    getJobs: jest
      .fn()
      .mockResolvedValue(
        (opts.liveIds ?? []).map((operationId) => ({ data: { operationId } })),
      ),
  };
  const hostCommand = {
    run: opts.uncordonFails
      ? jest.fn().mockRejectedValue(new Error('host unreachable'))
      : jest.fn().mockResolvedValue(''),
  };
  const service = new LostNodeOperationsService(
    operations as never,
    {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'c1', masterIpAddress: '203.0.113.10' }),
    } as never,
    { findOne: jest.fn().mockResolvedValue(opts.node ?? null) } as never,
    queue as never,
    hostCommand as never,
  );
  return { service, operations, hostCommand };
}

const removal = (over: Record<string, unknown> = {}) => ({
  id: 'op-remove',
  operationType: OperationType.REMOVE_WORKER,
  status: OperationStatus.IN_PROGRESS,
  resourceId: 'c1',
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
  metadata: { nodeId: 'n1', nodeName: 'worker-1' },
  ...over,
});

describe('node operations nothing carries any more', () => {
  it('closes a removal whose job is gone and puts its node back in service', async () => {
    const t = build({
      ops: [removal()],
      node: { id: 'n1', serverName: 'worker-1', status: NodeStatus.READY },
    });

    expect(await t.service.closeLost(NOW)).toBe(1);

    expect(t.hostCommand.run).toHaveBeenCalledWith(
      { host: '203.0.113.10', port: 22, user: 'root' },
      'kubectl uncordon worker-1',
      { timeoutMs: 30000 },
    );
    expect(t.operations.update).toHaveBeenCalledWith(
      'op-remove',
      expect.objectContaining({
        status: OperationStatus.FAILED,
        errorMessage: expect.stringContaining(
          'worker-1 was put back in service and nothing was removed',
        ),
      }),
    );
  });

  it('leaves alone an operation a job is still carrying', async () => {
    const t = build({ ops: [removal()], liveIds: ['op-remove'] });

    expect(await t.service.closeLost(NOW)).toBe(0);
    expect(t.operations.update).not.toHaveBeenCalled();
  });

  it('gives a just-queued operation time to reach the queue', async () => {
    const t = build({
      ops: [
        removal({
          createdAt: new Date(NOW.getTime() - 30_000),
          updatedAt: new Date(NOW.getTime() - 30_000),
        }),
      ],
    });

    expect(await t.service.closeLost(NOW)).toBe(0);
  });

  it('does not put back a node Flui had already started deleting', async () => {
    const t = build({
      ops: [removal()],
      node: { id: 'n1', serverName: 'worker-1', status: NodeStatus.DELETING },
    });

    await t.service.closeLost(NOW);

    expect(t.hostCommand.run).not.toHaveBeenCalled();
    expect(t.operations.update.mock.calls[0][1].errorMessage).toContain(
      'may be gone at the provider',
    );
  });

  it('says how to put the node back when it could not do it itself', async () => {
    const t = build({
      ops: [removal()],
      node: { id: 'n1', serverName: 'worker-1', status: NodeStatus.READY },
      uncordonFails: true,
    });

    await t.service.closeLost(NOW);

    expect(t.operations.update.mock.calls[0][1].errorMessage).toContain(
      'flui env uncordon worker-1',
    );
  });
});

describe('what a closed node operation says', () => {
  it('sends a lost purchase to the provider before anyone buys again', () => {
    expect(
      lostNodeOperationMessage(
        { operationType: OperationType.ADD_WORKER, nodeName: null },
        'not-attempted',
      ),
    ).toContain('Check the provider for a server that never joined');
  });
});
