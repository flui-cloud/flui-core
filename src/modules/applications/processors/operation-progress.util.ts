import { Not, Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  CANCELLED_IS_TERMINAL,
  haltIfCancelled,
} from '../../infrastructure/operations/helpers/operation-cancellation.helper';

/**
 * The one row-write both halves of the application queue make as they advance:
 * deploy and teardown. It lives here so the split of round E2 moved code
 * without leaving a second copy of it behind.
 */
export async function writeOperationProgress(
  operationRepository: Repository<InfrastructureOperationEntity>,
  operationId: string,
  status: OperationStatus,
  progress?: number,
  currentStep?: OperationStep,
  errorMessage?: string,
): Promise<void> {
  // The step boundary of the application queue. A stop asked for while a deploy
  // is between two steps is honoured here and nowhere else — mid-step is where
  // half-created Kubernetes objects come from.
  if (status === OperationStatus.IN_PROGRESS) {
    await haltIfCancelled(operationRepository, operationId);
  }

  const updateData: Partial<InfrastructureOperationEntity> = { status };
  if (progress !== undefined) updateData.progress = progress;
  if (currentStep !== undefined) updateData.currentStep = currentStep;
  if (errorMessage) updateData.errorMessage = errorMessage;
  if (status === OperationStatus.IN_PROGRESS && !updateData.startedAt) {
    updateData.startedAt = new Date();
  }
  if (
    status === OperationStatus.COMPLETED ||
    status === OperationStatus.FAILED
  ) {
    updateData.completedAt = new Date();
  }
  // Cancelled is the one verdict a progress write must not overwrite. The
  // worker learns it by exception and unwinds through its own error path, which
  // ends in `FAILED` — and a row that said "failed" where somebody stopped it
  // would lose the only distinction the register is asked for.
  await operationRepository.update(
    { id: operationId, status: Not(CANCELLED_IS_TERMINAL) },
    updateData,
  );
}
