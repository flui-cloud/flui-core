import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';

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
  await operationRepository.update(operationId, updateData);
}
