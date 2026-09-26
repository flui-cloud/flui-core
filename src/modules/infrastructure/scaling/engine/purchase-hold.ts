import { In, Not, Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';

const IN_FLIGHT = [OperationStatus.PENDING, OperationStatus.IN_PROGRESS];

/** A failed purchase that still holds the group back. */
export interface PurchaseHold {
  failedAt: Date;
  error: string | null;
  /** Set when the hold ends by itself: the machine was sold out. */
  until?: Date;
}

/** Minutes a provider's "none left" holds the group before availability decides again. */
export const SOLD_OUT_PAUSE_MINUTES = 10;

/**
 * Refusals a provider gives before any server exists because it has none of
 * that machine to sell right now. Nothing is left behind, so the condition is
 * temporary, not a fault for a person to look at.
 */
const SOLD_OUT = /\((resource_unavailable|placement_error)\)/;

export function soldOut(error: string | null | undefined): boolean {
  return !!error && SOLD_OUT.test(error);
}

/**
 * The purchase that holds a cluster's buying back, or null when none does.
 *
 * Only the latest finished purchase counts: one that went through after a
 * failure ends the hold on its own. A machine sold out between reading and
 * ordering holds only for a short pause, after which the next reading of
 * availability decides; any other failure holds until a person asks the group
 * to try again — the one reading shared by the loop that buys and every
 * surface that shows the group, so they cannot disagree.
 */
export async function purchaseHold(
  operations: Repository<InfrastructureOperationEntity>,
  clusterId: string,
  retryAskedAt: Date | null | undefined,
  now: Date = new Date(),
): Promise<PurchaseHold | null> {
  const last = await operations.findOne({
    where: {
      resourceId: clusterId,
      operationType: OperationType.ADD_WORKER,
      status: Not(In(IN_FLIGHT)),
    },
    order: { createdAt: 'DESC' },
  });
  if (last?.status !== OperationStatus.FAILED) return null;
  const failedAt = new Date(last.updatedAt ?? last.createdAt);
  if (retryAskedAt && new Date(retryAskedAt) >= failedAt) return null;
  const error = last.errorMessage ?? null;
  if (soldOut(error)) {
    const until = new Date(
      failedAt.getTime() + SOLD_OUT_PAUSE_MINUTES * 60_000,
    );
    if (now >= until) return null;
    return { failedAt, error, until };
  }
  return { failedAt, error };
}
