import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../servers/entities/infrastructure-operations.entity';
import {
  calculateOperationProgressFromSaved,
  getStepConfigFromSaved,
} from './helpers/operation-steps.helper';
import {
  haltIfCancelled,
  requestOperationCancellation,
} from './helpers/operation-cancellation.helper';

@Injectable()
export class InfrastructureOperationsService {
  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
  ) {}

  async getOperationDetails(
    operationId: string,
  ): Promise<InfrastructureOperationEntity> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });

    if (!operation) {
      throw new NotFoundException(`Operation ${operationId} not found`);
    }

    return operation;
  }

  /**
   * Ask a running operation to stop.
   *
   * A request, not an abort. It stops nothing this instant and says so: the
   * work is honoured at the next step boundary, because killing a ten-step
   * provisioning halfway through a step leaves resources the person keeps
   * paying for and cannot see. Idempotent, and terminal operations are left
   * alone — asking a finished thing to stop is not an error worth raising.
   */
  async requestCancellation(operationId: string): Promise<{
    operationId: string;
    status: OperationStatus;
    cancelRequested: boolean;
  }> {
    const operation = await this.getOperationDetails(operationId);
    const running =
      operation.status === OperationStatus.PENDING ||
      operation.status === OperationStatus.IN_PROGRESS;
    if (running && !operation.cancelRequestedAt) {
      await requestOperationCancellation(this.operationRepository, operationId);
    }
    return {
      operationId,
      status: operation.status,
      cancelRequested: running,
    };
  }

  /**
   * Update operation step and recalculate progress
   * Uses saved steps from metadata for accurate progress tracking
   */
  async updateOperationStep(
    operationId: string,
    stepIndex: number,
    stepProgress: number = 0,
    additionalMetadata: Record<string, any> = {},
  ): Promise<void> {
    // The cluster family's step boundary. Asked before the write rather than
    // after it, so a stop takes effect between two steps and never inside one:
    // a provisioning aborted mid-step is where paid-for orphans come from.
    await haltIfCancelled(this.operationRepository, operationId);

    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });

    if (!operation) {
      throw new NotFoundException(`Operation ${operationId} not found`);
    }

    // Get saved steps from metadata
    const savedSteps = operation.metadata?.operationSteps || [];

    if (savedSteps.length === 0) {
      throw new Error(
        `No operation steps found in metadata for operation ${operationId}`,
      );
    }

    const stepConfig = getStepConfigFromSaved(savedSteps, stepIndex);
    if (!stepConfig) {
      throw new Error(
        `Invalid step index ${stepIndex} for operation type ${operation.operationType}`,
      );
    }

    // Calculate overall progress
    const overallProgress = calculateOperationProgressFromSaved(
      savedSteps,
      stepIndex,
      stepProgress,
    );

    // Update operation fields
    operation.currentStep = stepConfig.step;
    operation.currentStepIndex = stepIndex;
    operation.totalSteps = savedSteps.length;
    operation.currentStepProgress = stepProgress;
    operation.progress = overallProgress;

    // Handle status changes
    if (additionalMetadata.status) {
      operation.status = additionalMetadata.status;
      if (
        additionalMetadata.status === OperationStatus.IN_PROGRESS &&
        !operation.startedAt
      ) {
        operation.startedAt = new Date();
      }
      if (additionalMetadata.status === OperationStatus.COMPLETED) {
        operation.completedAt = new Date();
      }
    }

    // Update metadata
    operation.metadata = {
      ...operation.metadata,
      ...additionalMetadata,
      stepDescription: stepConfig.description,
      stepWeight: stepConfig.weight,
      lastUpdated: new Date().toISOString(),
    };

    await this.operationRepository.save(operation);
  }
}
