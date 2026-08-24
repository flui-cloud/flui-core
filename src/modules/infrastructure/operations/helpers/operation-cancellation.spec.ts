import { FindOperator, Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../servers/entities/infrastructure-operations.entity';
import {
  OperationCancelledError,
  haltIfCancelled,
  isOperationCancelled,
  requestOperationCancellation,
} from './operation-cancellation.helper';
import { writeOperationProgress } from '../../../applications/processors/operation-progress.util';

/**
 * The "stop" of the cycle, which until this round was a verb with no machine:
 * `CANCELLED` sat in the status enum from the initial schema and nothing in the
 * module ever wrote it.
 *
 * Two behaviours have to hold together, and the second is the one that is easy
 * to forget: a worker learns it was stopped by an exception and unwinds through
 * its own error path, which ends in a write of `FAILED`. Without the sticky
 * rule the row would end up claiming the operation broke — losing exactly the
 * distinction the register exists to record.
 */
describe('asking an operation to stop', () => {
  function repo(row?: Partial<InfrastructureOperationEntity>) {
    const rows = row ? [{ id: 'op-1', ...row }] : [];
    return {
      rows,
      findOne: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      update: (
        criteria: Record<string, unknown> | string,
        patch: Record<string, unknown>,
      ) => {
        const where =
          typeof criteria === 'string' ? { id: criteria } : criteria;
        const hits = rows.filter((r) =>
          Object.entries(where).every(([key, expected]) => {
            const actual = (r as Record<string, unknown>)[key];
            if (expected instanceof FindOperator) {
              // Only `Not(...)` is used by the code under test.
              return actual !== expected.value;
            }
            return actual === expected;
          }),
        );
        for (const hit of hits) Object.assign(hit, patch);
        return Promise.resolve({ affected: hits.length });
      },
    } as unknown as Repository<InfrastructureOperationEntity> & {
      rows: Array<Partial<InfrastructureOperationEntity>>;
    };
  }

  it('lets an operation nobody stopped carry on', async () => {
    const r = repo({ status: OperationStatus.IN_PROGRESS });
    await expect(haltIfCancelled(r, 'op-1')).resolves.toBeUndefined();
    expect(r.rows[0].status).toBe(OperationStatus.IN_PROGRESS);
  });

  it('says nothing about an operation that does not exist', async () => {
    await expect(
      haltIfCancelled(repo(), 'op-missing'),
    ).resolves.toBeUndefined();
  });

  it('ends it at the boundary once somebody asked', async () => {
    const r = repo({ status: OperationStatus.IN_PROGRESS });
    await requestOperationCancellation(r, 'op-1');
    expect(r.rows[0].cancelRequestedAt).toBeInstanceOf(Date);
    // Still running at this point: the request alone changes nothing, which is
    // the difference between a cooperative stop and an abort mid-step.
    expect(r.rows[0].status).toBe(OperationStatus.IN_PROGRESS);

    await expect(haltIfCancelled(r, 'op-1')).rejects.toBeInstanceOf(
      OperationCancelledError,
    );
    expect(r.rows[0].status).toBe(OperationStatus.CANCELLED);
    expect(r.rows[0].completedAt).toBeInstanceOf(Date);
  });

  it('keeps stopping it on every later boundary', async () => {
    const r = repo({ status: OperationStatus.CANCELLED });
    const error = await haltIfCancelled(r, 'op-1').catch((e: unknown) => e);
    expect(isOperationCancelled(error)).toBe(true);
  });

  describe('a progress write after the stop', () => {
    it('does not overwrite the verdict with a failure', async () => {
      const r = repo({ status: OperationStatus.CANCELLED });
      await writeOperationProgress(
        r,
        'op-1',
        OperationStatus.FAILED,
        100,
        OperationStep.APP_DEPLOY_FINALIZE,
        'the worker unwound and reported a failure',
      );
      expect(r.rows[0].status).toBe(OperationStatus.CANCELLED);
      expect(r.rows[0].errorMessage).toBeUndefined();
    });

    it('is the boundary itself while the operation is still moving', async () => {
      const r = repo({ status: OperationStatus.IN_PROGRESS });
      await requestOperationCancellation(r, 'op-1');
      await expect(
        writeOperationProgress(r, 'op-1', OperationStatus.IN_PROGRESS, 40),
      ).rejects.toBeInstanceOf(OperationCancelledError);
      expect(r.rows[0].status).toBe(OperationStatus.CANCELLED);
    });

    it('still writes normally when nobody asked for anything', async () => {
      const r = repo({ status: OperationStatus.PENDING });
      await writeOperationProgress(
        r,
        'op-1',
        OperationStatus.IN_PROGRESS,
        25,
        OperationStep.APP_DEPLOY_BUILD,
      );
      expect(r.rows[0].status).toBe(OperationStatus.IN_PROGRESS);
      expect(r.rows[0].progress).toBe(25);
      expect(r.rows[0].currentStep).toBe(OperationStep.APP_DEPLOY_BUILD);
      expect(r.rows[0].startedAt).toBeInstanceOf(Date);
    });

    it('still records a genuine failure', async () => {
      const r = repo({ status: OperationStatus.IN_PROGRESS });
      await writeOperationProgress(
        r,
        'op-1',
        OperationStatus.FAILED,
        60,
        undefined,
        'image pull failed',
      );
      expect(r.rows[0].status).toBe(OperationStatus.FAILED);
      expect(r.rows[0].errorMessage).toBe('image pull failed');
      expect(r.rows[0].completedAt).toBeInstanceOf(Date);
    });
  });
});
