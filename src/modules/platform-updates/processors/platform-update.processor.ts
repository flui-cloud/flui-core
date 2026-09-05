import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RELEASE } from '../../../config/release.config';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { PlatformUpdatesService } from '../services/platform-updates.service';
import {
  PLATFORM_UPDATE_JOB,
  PLATFORM_UPDATE_QUEUE,
  PlatformUpdateJobData,
} from '../services/platform-update-runner.service';
import { PlatformComponentKey } from '../constants/platform-update-components';

const CHILD_POLL_INTERVAL_MS = 5_000;
const CHILD_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Applies a platform release, one component at a time, through the same deploy
 * path everything else uses — so a platform update leaves the same audit trail,
 * revisions and image provenance as any other rollout.
 *
 * The API is deliberately last and deliberately unattended: rolling it out
 * terminates this process mid-job, so the step is recorded as awaiting a
 * restart *before* it is triggered, and the pod that comes up on the new
 * version closes it (see PlatformUpdateResumeService).
 */
@Processor(PLATFORM_UPDATE_QUEUE)
export class PlatformUpdateProcessor {
  private readonly logger = new Logger(PlatformUpdateProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    private readonly deployService: ApplicationDeployService,
    private readonly platformUpdates: PlatformUpdatesService,
  ) {}

  @Process(PLATFORM_UPDATE_JOB)
  async run(job: Job<PlatformUpdateJobData>): Promise<void> {
    const { operationId } = job.data;
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (!operation) {
      this.logger.error(`Platform update operation ${operationId} not found`);
      return;
    }
    const metadata = operation.metadata as PlatformUpdateOperationMetadata;

    try {
      await this.step(operationId, OperationStep.PLATFORM_UPDATE_PREFLIGHT, 5);
      const appIds = await this.platformUpdates.componentAppIds();

      await this.step(
        operationId,
        OperationStep.PLATFORM_UPDATE_COMPONENTS,
        15,
        1,
      );
      for (const component of metadata.components) {
        if (component.status !== 'pending') continue;
        if (component.key === 'fluiApi') continue;
        await this.rollout(
          operationId,
          metadata,
          component,
          appIds.get(component.key as PlatformComponentKey),
        );
      }

      const api = metadata.components.find((c) => c.key === 'fluiApi');
      if (api?.status === 'pending') {
        await this.rolloutControlPlane(
          operationId,
          metadata,
          api,
          appIds.get('fluiApi'),
        );
        return;
      }

      await this.step(operationId, OperationStep.PLATFORM_UPDATE_VERIFY, 95, 3);
      await this.complete(operationId, metadata);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Platform update ${operationId} failed: ${message}`);
      await this.patch(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: message,
        completedAt: new Date(),
        metadata: { ...metadata, error: message },
      });
    }
  }

  private async rollout(
    operationId: string,
    metadata: PlatformUpdateOperationMetadata,
    component: PlatformUpdateOperationMetadata['components'][number],
    applicationId: string | undefined,
  ): Promise<void> {
    if (!applicationId) {
      throw new Error(
        `${component.name} has no system-app row on the control cluster to deploy through.`,
      );
    }
    await this.markComponent(operationId, metadata, component.key, 'running');
    const child = await this.deployService.setDesiredImage(
      applicationId,
      component.imageRef,
    );
    const outcome = await this.awaitOperation(child.id);
    if (outcome !== OperationStatus.COMPLETED) {
      await this.markComponent(operationId, metadata, component.key, 'failed');
      throw new Error(
        `${component.name} did not roll out to ${component.targetVersion} (deploy ${child.id} ended ${outcome}).`,
      );
    }
    await this.markComponent(operationId, metadata, component.key, 'done');
  }

  /**
   * The step that cannot report its own outcome. The metadata is written first
   * on purpose: after `setDesiredImage` the pod running this line is replaced,
   * and everything below it may never execute.
   */
  private async rolloutControlPlane(
    operationId: string,
    metadata: PlatformUpdateOperationMetadata,
    component: PlatformUpdateOperationMetadata['components'][number],
    applicationId: string | undefined,
  ): Promise<void> {
    if (!applicationId) {
      throw new Error(
        'Flui API has no system-app row on the control cluster to deploy through.',
      );
    }
    const components = metadata.components.map((c) =>
      c.key === component.key ? { ...c, status: 'running' as const } : c,
    );
    await this.patch(operationId, {
      status: OperationStatus.IN_PROGRESS,
      currentStep: OperationStep.PLATFORM_UPDATE_CONTROL_PLANE,
      currentStepIndex: 2,
      progress: 60,
      metadata: {
        ...metadata,
        components,
        awaitingSelfRestart: true,
        awaitingSince: new Date().toISOString(),
      },
    });
    this.logger.log(
      `Rolling out the control plane to ${component.targetVersion}; this process ends here and the new pod finishes the operation.`,
    );
    await this.deployService.setDesiredImage(applicationId, component.imageRef);
  }

  private async awaitOperation(id: string): Promise<OperationStatus> {
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const child = await this.operationRepository.findOne({ where: { id } });
      if (
        child &&
        child.status !== OperationStatus.PENDING &&
        child.status !== OperationStatus.IN_PROGRESS
      ) {
        return child.status;
      }
      await new Promise((r) => setTimeout(r, CHILD_POLL_INTERVAL_MS));
    }
    return OperationStatus.FAILED;
  }

  private async markComponent(
    operationId: string,
    metadata: PlatformUpdateOperationMetadata,
    key: string,
    status: PlatformUpdateOperationMetadata['components'][number]['status'],
  ): Promise<void> {
    const components = metadata.components.map((c) =>
      c.key === key ? { ...c, status } : c,
    );
    metadata.components = components;
    await this.patch(operationId, { metadata: { ...metadata, components } });
  }

  private async complete(
    operationId: string,
    metadata: PlatformUpdateOperationMetadata,
  ): Promise<void> {
    await this.patch(operationId, {
      status: OperationStatus.COMPLETED,
      progress: 100,
      currentStepIndex: metadata.operationSteps
        ? metadata.operationSteps.length - 1
        : 3,
      completedAt: new Date(),
      metadata: {
        ...metadata,
        awaitingSelfRestart: false,
        message: `Updated to Flui ${metadata.targetVersion} (API on ${RELEASE.version}).`,
      },
    });
  }

  /**
   * Writes through the loaded row rather than `update()`: the metadata carries
   * the per-component array, which TypeORM's deep-partial shape for a union
   * column will not take.
   */
  private async patch(
    operationId: string,
    changes: Partial<InfrastructureOperationEntity>,
  ): Promise<void> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (!operation) return;
    Object.assign(operation, changes);
    await this.operationRepository.save(operation);
  }

  private async step(
    operationId: string,
    step: OperationStep,
    progress: number,
    index = 0,
  ): Promise<void> {
    await this.operationRepository.update(operationId, {
      status: OperationStatus.IN_PROGRESS,
      currentStep: step,
      currentStepIndex: index,
      progress,
      ...(progress <= 5 ? { startedAt: new Date() } : {}),
    });
  }
}
