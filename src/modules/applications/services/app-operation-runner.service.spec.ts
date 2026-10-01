import { AppOperationRunner } from './app-operation-runner.service';
import {
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';

function build(existing?: Record<string, any>) {
  const saved: any[] = [];
  const repo = {
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn(async (x) => {
      saved.push({ ...x });
      return { id: x.id ?? 'op-new', ...x };
    }),
    findOne: jest.fn(async () => (existing ? { ...existing } : null)),
  };
  const gateway = {
    emitOperationProgress: jest.fn(),
    emitOperationCompleted: jest.fn(),
    emitOperationFailed: jest.fn(),
  };
  return {
    runner: new AppOperationRunner(repo as any, gateway as any),
    repo,
    saved,
  };
}

const ctx = {
  appId: 'a1',
  operationType: OperationType.APP_BACKUP_CREATE,
  resourceName: 'web',
};

describe('an operation opened before its work runs', () => {
  it('is the one the work reports into, not a second one', async () => {
    const { runner, repo, saved } = build({
      id: 'op-1',
      status: OperationStatus.PENDING,
      metadata: { appId: 'a1', queued: true },
    });
    const { operationId } = await runner.run(
      { ...ctx, operationId: 'op-1', metadata: { engine: 'kopia' } },
      async () => ({ ok: true }),
    );
    expect(operationId).toBe('op-1');
    expect(repo.create).not.toHaveBeenCalled();
    const last = saved[saved.length - 1];
    expect(last).toMatchObject({
      id: 'op-1',
      status: OperationStatus.COMPLETED,
      metadata: {
        appId: 'a1',
        queued: true,
        engine: 'kopia',
        result: { ok: true },
      },
    });
  });

  it('keeps a structured refusal on the failed operation', async () => {
    const { runner, saved } = build({
      id: 'op-1',
      status: OperationStatus.PENDING,
      metadata: {},
    });
    const refusal = Object.assign(new Error('refused'), {
      response: { code: 'VOLUME_COPY_REFUSED', options: ['pause'] },
    });
    await expect(
      runner.run({ ...ctx, operationId: 'op-1' }, async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(saved[saved.length - 1]).toMatchObject({
      status: OperationStatus.FAILED,
      metadata: { error: { code: 'VOLUME_COPY_REFUSED', options: ['pause'] } },
    });
  });

  it('closes a pending operation whose work never started, and leaves a finished one alone', async () => {
    const pending = build({
      id: 'op-1',
      status: OperationStatus.PENDING,
      metadata: {},
    });
    await pending.runner.failIfPending('op-1', new Error('no volume'));
    expect(pending.saved[0]).toMatchObject({
      status: OperationStatus.FAILED,
      errorMessage: 'no volume',
    });

    const done = build({
      id: 'op-2',
      status: OperationStatus.COMPLETED,
      metadata: {},
    });
    await done.runner.failIfPending('op-2', new Error('late'));
    expect(done.saved).toHaveLength(0);
  });
});
