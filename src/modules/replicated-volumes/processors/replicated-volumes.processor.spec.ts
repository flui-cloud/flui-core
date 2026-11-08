jest.mock('@kubernetes/client-node', () => ({}));

import { ReplicatedVolumesProcessor } from './replicated-volumes.processor';
import { OperationStatus } from '../../infrastructure/servers/entities/infrastructure-operations.entity';

describe('ReplicatedVolumesProcessor.enable', () => {
  function build(voteState: { kind: string; kernel?: string }) {
    const order: string[] = [];
    const operations = { update: jest.fn().mockResolvedValue(undefined) };
    const preparer = {
      prepare: jest.fn(async (_k: string, node: string) => {
        order.push(`copies ${node}`);
        return { kind: 'ready', sizeGiB: 20 };
      }),
      prepareVote: jest.fn(async (_k: string, node: string) => {
        order.push(`vote ${node}`);
        return voteState;
      }),
    };
    const installer = {
      ensureOperator: jest.fn(async () => order.push('engine')),
      ensureCluster: jest.fn(),
      moveControlOffCopies: jest.fn(),
      ensureStorageClass: jest.fn(),
    };
    const processor = new ReplicatedVolumesProcessor(
      {
        findOneOrFail: jest
          .fn()
          .mockResolvedValue({ name: 'ha-hz', kubeconfigEncrypted: 'x' }),
      } as never,
      operations as never,
      { decrypt: () => 'kubeconfig' } as never,
      preparer as never,
      installer as never,
    );
    const run = () =>
      processor.enable({
        data: {
          operationId: 'op-1',
          clusterId: 'c-1',
          storageNodes: ['ha-hz-master', 'ha-hz-worker-1'],
          sizeGiB: 20,
          voteZones: ['hel1'],
          tieBreakers: ['ha-hz-worker-2'],
        },
      } as never);
    return { run, order, operations, installer };
  }

  it('prepares the node that votes as well, before installing the engine', async () => {
    const { run, order, operations } = build({ kind: 'ready' });

    await run();

    expect(order).toEqual([
      'copies ha-hz-master',
      'copies ha-hz-worker-1',
      'vote ha-hz-worker-2',
      'engine',
    ]);
    expect(operations.update).toHaveBeenLastCalledWith(
      'op-1',
      expect.objectContaining({ status: OperationStatus.COMPLETED }),
    );
  });

  it('stops before installing anything when the vote cannot load the engine module', async () => {
    const { run, operations, installer } = build({
      kind: 'no-headers',
      kernel: '6.8.0-138-generic',
    });

    await run();

    expect(installer.ensureOperator).not.toHaveBeenCalled();
    expect(operations.update).toHaveBeenLastCalledWith(
      'op-1',
      expect.objectContaining({
        status: OperationStatus.FAILED,
        errorMessage: expect.stringContaining(
          'ha-hz-worker-2 has no kernel headers for 6.8.0-138-generic',
        ),
      }),
    );
  });
});
