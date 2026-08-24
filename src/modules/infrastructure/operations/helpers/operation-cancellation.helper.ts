import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../../servers/entities/infrastructure-operations.entity';

/**
 * The "stop" of the cycle — propose, price, approve, execute, attribute,
 * **stop** — which until now was a verb with no machine: `CANCELLED` has been
 * in the status enum since the initial schema and nothing in the module ever
 * wrote it.
 *
 * What was missing was never the status. It was the honest place to honour a
 * stop. A ten-step provisioning killed in the middle of a step leaves
 * paid-for resources orphaned behind it — `env orphan-volumes` exists
 * *because* that failure mode exists — so a cancellation is a **request**,
 * recorded on the row, and honoured where the work sits between two consistent
 * points: a step boundary.
 *
 * Two rules, and both are needed:
 *
 *  - {@link haltIfCancelled} is asked at a boundary, flips the row to
 *    `CANCELLED` and throws, so the worker unwinds through its own error path;
 *  - {@link CANCELLED_IS_TERMINAL} makes that verdict stick. A processor's
 *    `catch` will try to write `FAILED` immediately afterwards, and without the
 *    guard the row would end up saying the operation broke when in fact
 *    somebody stopped it — the one distinction the register exists to keep.
 */

/** Thrown at a step boundary when the operation has been asked to stop. */
export class OperationCancelledError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Operation ${operationId} was cancelled by request; stopped at a step boundary.`,
    );
    this.name = 'OperationCancelledError';
  }
}

export function isOperationCancelled(error: unknown): boolean {
  return error instanceof OperationCancelledError;
}

/**
 * Statuses a progress write may never overwrite.
 *
 * Only `CANCELLED` is here, and deliberately: `FAILED` and `COMPLETED` are
 * written by the same processors that write progress, so treating them as
 * sticky would break retries. A cancellation is written by somebody else, and
 * has to survive the worker noticing.
 */
export const CANCELLED_IS_TERMINAL = OperationStatus.CANCELLED;

/** Record the wish to stop. Idempotent: the first request is the one that counts. */
export async function requestOperationCancellation(
  repository: Repository<InfrastructureOperationEntity>,
  operationId: string,
): Promise<void> {
  await repository.update(
    { id: operationId },
    { cancelRequestedAt: new Date() },
  );
}

/**
 * The step boundary itself: stop here, or carry on.
 *
 * Reads the row rather than trusting one held in memory, because the request to
 * stop arrives from a different process entirely — an HTTP call on the API,
 * while the work runs in a queue worker.
 */
export async function haltIfCancelled(
  repository: Repository<InfrastructureOperationEntity>,
  operationId: string,
): Promise<void> {
  const row = await repository.findOne({
    where: { id: operationId },
    select: { id: true, status: true, cancelRequestedAt: true },
  });
  if (!row) return;
  if (row.status === OperationStatus.CANCELLED) {
    throw new OperationCancelledError(operationId);
  }
  if (!row.cancelRequestedAt) return;
  await repository.update(
    { id: operationId },
    {
      status: OperationStatus.CANCELLED,
      completedAt: new Date(),
      errorMessage:
        'Stopped on request at a step boundary. Anything already provisioned was left in place rather than half-removed.',
    },
  );
  throw new OperationCancelledError(operationId);
}
