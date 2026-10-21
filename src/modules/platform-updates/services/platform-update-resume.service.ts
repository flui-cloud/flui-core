import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  withAdvisoryLock,
  withAdvisoryLockWaiting,
} from '../../common/leadership/advisory-lock';
import { RELEASE } from '../../../config/release.config';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
  OperationType,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  PLATFORM_UPDATE_QUEUE,
  PlatformUpdateJobData,
  enqueueUpgrade,
} from '../constants/platform-update-queue';
import {
  PlatformUpgradeMetadata,
  isUpgradeMetadata,
} from '../interfaces/platform-upgrade.interface';
import {
  continuedAfterRestart,
  controlPlaneDeployFailure,
  failedMetadata,
  overduePhase,
} from '../utils/upgrade-state.util';

const STALL_TIMEOUT_MS = 15 * 60 * 1_000;
const LOCK_NAME = 'platform-update-resume';

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
    @Optional()
    @InjectQueue(PLATFORM_UPDATE_QUEUE)
    private readonly queue?: Queue<PlatformUpdateJobData>,
  ) {}

  /**
   * Every copy of the API on the new version boots into this: one at a time,
   * each reading the operation afresh, so only the first one continues it.
   */
  async onApplicationBootstrap(): Promise<void> {
    await withAdvisoryLockWaiting(this.dataSource, LOCK_NAME, () =>
      this.resumeAwaiting(),
    );
  }

  private async resumeAwaiting(): Promise<void> {
    const pending = await this.awaiting();
    for (const operation of pending) {
      const metadata = operation.metadata as PlatformUpdateOperationMetadata;
      if (isUpgradeMetadata(metadata)) {
        if (metadata.targetVersion === RELEASE.version) {
          await this.continueUpgrade(operation, metadata);
        }
        continue;
      }
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
    await withAdvisoryLock(this.dataSource, LOCK_NAME, () =>
      this.failStalledHeld(),
    );
  }

  private async failStalledHeld(): Promise<void> {
    await this.failOverduePhases();
    const pending = await this.awaiting();
    for (const operation of pending) {
      const metadata = operation.metadata as PlatformUpdateOperationMetadata;
      if (isUpgradeMetadata(metadata)) continue;
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
      await this.settle(operation.id, {
        status: OperationStatus.FAILED,
        errorMessage: message,
        completedAt: new Date(),
        metadata: {
          ...metadata,
          awaitingSelfRestart: false,
          components: metadata.components.map((c) =>
            c.status === 'running' ? { ...c, status: 'failed' as const } : c,
          ),
          error: message,
        },
      });
    }
  }

  /**
   * The phased update does not complete here: the pod on the new version
   * records the images as rolled out and carries on with K3s and the checks.
   */
  private async continueUpgrade(
    operation: InfrastructureOperationEntity,
    metadata: PlatformUpgradeMetadata,
  ): Promise<void> {
    const settled = await this.settle(operation.id, {
      metadata: continuedAfterRestart(metadata, new Date()),
    });
    if (!settled) return;
    if (this.queue) await enqueueUpgrade(this.queue, operation.id);
    this.logger.log(
      `Platform update ${operation.id}: the API is on ${RELEASE.version}; continuing with K3s and the checks.`,
    );
  }

  /** Each phase of a planned update has its own deadline. */
  private async failOverduePhases(): Promise<void> {
    const running = await this.inProgress();
    for (const operation of running) {
      const metadata = operation.metadata;
      if (!isUpgradeMetadata(metadata)) continue;
      const replacementFailed = await this.controlPlaneDeployFailed(metadata);
      if (replacementFailed) {
        await this.failPhase(operation, metadata, 'images', replacementFailed);
        continue;
      }
      const overdue = overduePhase(metadata, Date.now());
      if (!overdue) continue;
      if (
        overdue.key === 'images' &&
        metadata.awaitingSelfRestart &&
        metadata.targetVersion === RELEASE.version
      ) {
        await this.continueUpgrade(operation, metadata);
        continue;
      }
      const message =
        overdue.key === 'images' && metadata.awaitingSelfRestart
          ? `The API never came back on ${metadata.targetVersion}; it is still serving ${RELEASE.version}.`
          : `${overdue.title} did not finish before its deadline.`;
      await this.failPhase(operation, metadata, overdue.key, message);
    }
  }

  /**
   * The update is parked on a deploy that has already ended without the new
   * API: waiting for the phase deadline would only keep the screen saying the
   * control plane is restarting.
   */
  private async controlPlaneDeployFailed(
    metadata: PlatformUpgradeMetadata,
  ): Promise<string | null> {
    if (!metadata.awaitingSelfRestart || !metadata.controlPlaneDeployId) {
      return null;
    }
    const api = metadata.components.find((c) => c.key === 'fluiApi');
    if (!api) return null;
    const deploy = await this.operationRepository.findOne({
      where: { id: metadata.controlPlaneDeployId },
    });
    return controlPlaneDeployFailure(
      deploy as Parameters<typeof controlPlaneDeployFailure>[0],
      api.imageRef,
    );
  }

  private async failPhase(
    operation: InfrastructureOperationEntity,
    metadata: PlatformUpgradeMetadata,
    key: Parameters<typeof failedMetadata>[1],
    message: string,
  ): Promise<void> {
    this.logger.error(`Platform update ${operation.id} stalled: ${message}`);
    const now = new Date();
    const failed = failedMetadata(metadata, key, message, RELEASE.version, now);
    await this.settle(operation.id, {
      status: OperationStatus.FAILED,
      errorMessage: `${message} ${failed.guidance ?? ''}`.trim(),
      completedAt: now,
      metadata: failed,
    });
  }

  private async inProgress(): Promise<InfrastructureOperationEntity[]> {
    return this.operationRepository.find({
      where: {
        operationType: OperationType.UPDATE_PLATFORM,
        status: OperationStatus.IN_PROGRESS,
      },
      order: { createdAt: 'DESC' },
    });
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
    const settled = await this.settle(operation.id, {
      status: OperationStatus.COMPLETED,
      progress: 100,
      currentStep: OperationStep.PLATFORM_UPDATE_VERIFY,
      currentStepIndex: Math.max((metadata.operationSteps?.length ?? 4) - 1, 0),
      completedAt: new Date(),
      metadata: {
        ...metadata,
        awaitingSelfRestart: false,
        components: metadata.components.map((c) =>
          c.status === 'running' ? { ...c, status: 'done' as const } : c,
        ),
        message: `Updated to Flui ${metadata.targetVersion}.`,
      },
    });
    if (!settled) return;
    this.logger.log(
      `Platform update ${operation.id} completed: this build is ${RELEASE.version}.`,
    );
  }

  /**
   * Writes only the fields this decision owns, and only while the operation is
   * still running: a newer outcome recorded meanwhile is never overwritten.
   */
  private async settle(
    id: string,
    changes: Partial<
      Pick<
        InfrastructureOperationEntity,
        | 'status'
        | 'errorMessage'
        | 'completedAt'
        | 'progress'
        | 'currentStep'
        | 'currentStepIndex'
        | 'metadata'
      >
    >,
  ): Promise<boolean> {
    const result = await this.operationRepository.update(
      { id, status: OperationStatus.IN_PROGRESS },
      changes as QueryDeepPartialEntity<InfrastructureOperationEntity>,
    );
    return (result.affected ?? 0) > 0;
  }

  private get dataSource() {
    return this.operationRepository.manager.connection;
  }
}
