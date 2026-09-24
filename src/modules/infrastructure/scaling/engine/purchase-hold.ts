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
}

/**
 * The purchase that holds a cluster's buying back, or null when none does.
 *
 * Only the latest finished purchase counts: one that went through after a
 * failure ends the hold on its own. Otherwise the hold lasts until a person
 * asks the group to try again — the one reading shared by the loop that buys
 * and every surface that shows the group, so they cannot disagree.
 */
export async function purchaseHold(
  operations: Repository<InfrastructureOperationEntity>,
  clusterId: string,
  retryAskedAt: Date | null | undefined,
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
  return { failedAt, error: last.errorMessage ?? null };
}
