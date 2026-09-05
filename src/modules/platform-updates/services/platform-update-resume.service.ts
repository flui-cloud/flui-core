import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RELEASE } from '../../../config/release.config';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
  OperationType,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';

const STALL_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Closes the step nobody was left to close.
 *
 * The last thing a platform update does is replace the process running it, so
 * the operation is parked with `awaitingSelfRestart` and finished from the
 * other side: either this pod boots on the target version — the update worked —
 * or it never does, and the watchdog says so rather than leaving a spinner
 * turning forever. A Deployment keeps the old pod serving until the new one is
 * ready, so "the API never came back on the new version" is exactly the shape a
 * failed control-plane rollout takes.
 */
@Injectable()
export class PlatformUpdateResumeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformUpdateResumeService.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pending = await this.awaiting();
    for (const operation of pending) {
      const metadata = operation.metadata as PlatformUpdateOperationMetadata;
      if (metadata.targetVersion !== RELEASE.version) {
        // The old pod restarted for its own reasons while the rollout was in
        // flight. Deciding failure here would fail an update still running.
        this.logger.warn(
          `Platform update ${operation.id} targets ${metadata.targetVersion}; this build is ${RELEASE.version}. Leaving it to the watchdog.`,
        );
        continue;
      }
      await this.complete(operation, metadata);
    }
  }

  @Cron(
    process.env.PLATFORM_UPDATE_WATCHDOG_CRON || CronExpression.EVERY_MINUTE,
  )
  async failStalled(): Promise<void> {
    const pending = await this.awaiting();
    for (const operation of pending) {
      const metadata = operation.metadata as PlatformUpdateOperationMetadata;
      const since = metadata.awaitingSince
        ? Date.parse(metadata.awaitingSince)
        : operation.createdAt.getTime();
      if (Date.now() - since < STALL_TIMEOUT_MS) continue;

      if (metadata.targetVersion === RELEASE.version) {
        await this.complete(operation, metadata);
        continue;
      }
      const message = `The API never came back on ${metadata.targetVersion}; it is still serving ${RELEASE.version}. The other components were left on their new versions — roll back or retry from Updates.`;
      this.logger.error(`Platform update ${operation.id} stalled: ${message}`);
      operation.status = OperationStatus.FAILED;
      operation.errorMessage = message;
      operation.completedAt = new Date();
      operation.metadata = {
        ...metadata,
        awaitingSelfRestart: false,
        components: metadata.components.map((c) =>
          c.status === 'running' ? { ...c, status: 'failed' as const } : c,
        ),
        error: message,
      };
      await this.operationRepository.save(operation);
    }
  }

  private async awaiting(): Promise<InfrastructureOperationEntity[]> {
    const running = await this.operationRepository.find({
      where: {
        operationType: OperationType.UPDATE_PLATFORM,
        status: OperationStatus.IN_PROGRESS,
      },
      order: { createdAt: 'DESC' },
    });
    return running.filter(
      (o) =>
        (o.metadata as PlatformUpdateOperationMetadata).awaitingSelfRestart,
    );
  }

  private async complete(
    operation: InfrastructureOperationEntity,
    metadata: PlatformUpdateOperationMetadata,
  ): Promise<void> {
    operation.status = OperationStatus.COMPLETED;
    operation.progress = 100;
    operation.currentStep = OperationStep.PLATFORM_UPDATE_VERIFY;
    operation.currentStepIndex = Math.max(
      (metadata.operationSteps?.length ?? 4) - 1,
      0,
    );
    operation.completedAt = new Date();
    operation.metadata = {
      ...metadata,
      awaitingSelfRestart: false,
      components: metadata.components.map((c) =>
        c.status === 'running' ? { ...c, status: 'done' as const } : c,
      ),
      message: `Updated to Flui ${metadata.targetVersion}.`,
    };
    await this.operationRepository.save(operation);
    this.logger.log(
      `Platform update ${operation.id} completed: this build is ${RELEASE.version}.`,
    );
  }
}
