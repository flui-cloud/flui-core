import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEventsGateway } from '../gateway/application-events.gateway';
import { describeError } from '../../shared/utils/error.util';

export interface AppOperationContext {
  appId: string;
  operationType: OperationType;
  resourceName: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  /** An operation `open` already recorded; the work reports into it instead of a new one. */
  operationId?: string;
}

@Injectable()
export class AppOperationRunner {
  private readonly logger = new Logger(AppOperationRunner.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    private readonly gateway: ApplicationEventsGateway,
  ) {}

  /**
   * Records the operation now, for work that runs later: the caller answers
   * with its id at once and the work reports into it through `run`.
   */
  async open(ctx: AppOperationContext): Promise<InfrastructureOperationEntity> {
    return this.operationRepository.save(
      this.operationRepository.create({
        operationType: ctx.operationType,
        status: OperationStatus.PENDING,
        resourceType: 'application',
        resourceName: ctx.resourceName,
        resourceId: ctx.appId,
        userId: ctx.userId,
        totalSteps: 1,
        currentStepIndex: 0,
        currentStepProgress: 0,
        metadata: { appId: ctx.appId, ...ctx.metadata },
      }),
    );
  }

  async run<T>(
    ctx: AppOperationContext,
    work: (op: InfrastructureOperationEntity) => Promise<T>,
  ): Promise<{ result: T; operationId: string }> {
    const opened = ctx.operationId
      ? await this.operationRepository.findOne({
          where: { id: ctx.operationId },
        })
      : null;
    const saved = opened
      ? Object.assign(opened, {
          metadata: { ...opened.metadata, ...ctx.metadata },
        })
      : await this.open(ctx);
    const startedAt = Date.now();

    saved.status = OperationStatus.IN_PROGRESS;
    saved.startedAt = new Date();
    await this.operationRepository.save(saved);
    this.gateway.emitOperationProgress(ctx.appId, {
      appId: ctx.appId,
      operationId: saved.id,
      operationType: ctx.operationType,
      percentage: 0,
      currentStep: 0,
      totalSteps: 1,
      message: `${ctx.operationType} started`,
      timestamp: new Date(),
    });

    try {
      const result = await work(saved);
      saved.status = OperationStatus.COMPLETED;
      saved.completedAt = new Date();
      saved.currentStepIndex = 1;
      saved.currentStepProgress = 100;
      saved.metadata = {
        ...saved.metadata,
        result: this.summarizeResult(result),
      };
      await this.operationRepository.save(saved);
      this.gateway.emitOperationCompleted(ctx.appId, {
        appId: ctx.appId,
        operationId: saved.id,
        operationType: ctx.operationType,
        duration: Date.now() - startedAt,
        timestamp: new Date(),
      });
      return { result, operationId: saved.id };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      saved.status = OperationStatus.FAILED;
      saved.errorMessage = message;
      // A structured refusal keeps its shape, so a caller that learns of the
      // failure later can still offer the ways forward it names.
      if (
        err?.response &&
        typeof err.response === 'object' &&
        err.response.code
      ) {
        saved.metadata = { ...saved.metadata, error: err.response };
      }
      saved.completedAt = new Date();
      await this.operationRepository.save(saved);
      this.gateway.emitOperationFailed(ctx.appId, {
        appId: ctx.appId,
        operationId: saved.id,
        operationType: ctx.operationType,
        error: message,
        timestamp: new Date(),
      });
      throw err;
    }
  }

  /** Closes an operation whose work failed before it started reporting. */
  async failIfPending(operationId: string, err: unknown): Promise<void> {
    const op = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (op?.status !== OperationStatus.PENDING) return;
    const e = err as { message?: string; response?: any };
    op.status = OperationStatus.FAILED;
    op.errorMessage = e?.message ?? describeError(err);
    op.completedAt = new Date();
    if (e?.response && typeof e.response === 'object' && e.response.code) {
      op.metadata = { ...op.metadata, error: e.response };
    }
    await this.operationRepository.save(op);
  }

  private summarizeResult(result: unknown): unknown {
    if (result === null || result === undefined) return null;
    if (typeof result === 'object') {
      try {
        return structuredClone(result);
      } catch {
        return null;
      }
    }
    return result;
  }
}
