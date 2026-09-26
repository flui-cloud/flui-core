import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Queue } from 'bull';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  LOST_OPERATION_MESSAGE,
  lostOperations,
} from '../utils/lost-operations.core';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { ApplicationReconciliationService } from './application-reconciliation.service';
import { ApplicationStatus } from '../enums/application-status.enum';

const QUEUED_TYPES = [
  OperationType.DEPLOY_APPLICATION,
  OperationType.DELETE_APPLICATION,
];

@Injectable()
export class LostOperationsService {
  private readonly logger = new Logger(LostOperationsService.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectQueue('application-deploy')
    private readonly deployQueue: Queue,
    private readonly applications: ApplicationsRepository,
    private readonly reconciliation: ApplicationReconciliationService,
  ) {}

  /**
   * `updating` is only true while a deploy is running. Read on an app that says
   * it with nothing behind it, the word is replaced by what the cluster reports
   * before anyone sees it.
   */
  async settle(
    applicationId: string,
    status: ApplicationStatus,
  ): Promise<void> {
    if (status !== ApplicationStatus.UPDATING) return;
    try {
      await this.closeLost();
      if (await this.applications.isOrphanedUpdate(applicationId)) {
        await this.reconciliation.reconcileOne(applicationId);
      }
    } catch (err) {
      this.logger.warn(
        `[lost-ops] ${applicationId} not settled: ${(err as Error).message}`,
      );
    }
  }

  /** Marks failed every application operation no job carries any more; returns how many. */
  async closeLost(): Promise<number> {
    const inFlight = await this.operations.find({
      where: {
        operationType: In(QUEUED_TYPES),
        status: In([OperationStatus.PENDING, OperationStatus.IN_PROGRESS]),
      },
      select: { id: true, createdAt: true, updatedAt: true },
    });
    if (!inFlight.length) return 0;

    const jobs = await this.deployQueue.getJobs([
      'waiting',
      'active',
      'delayed',
      'paused',
    ]);
    const live = new Set(
      jobs
        .map(
          (job) =>
            (job?.data as { operationId?: string } | undefined)?.operationId,
        )
        .filter((id): id is string => typeof id === 'string'),
    );

    const lost = lostOperations(inFlight, live, new Date());
    for (const op of lost) {
      await this.operations.update(op.id, {
        status: OperationStatus.FAILED,
        errorMessage: LOST_OPERATION_MESSAGE,
        completedAt: new Date(),
      });
    }
    if (lost.length) {
      this.logger.warn(
        `[lost-ops] closed ${lost.length} operation(s) no job was running`,
      );
    }
    return lost.length;
  }
}
