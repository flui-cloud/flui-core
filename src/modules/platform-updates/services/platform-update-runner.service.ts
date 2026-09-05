import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, Repository } from 'typeorm';
import { RELEASE } from '../../../config/release.config';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
  OperationType,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { PlatformUpdatesService } from './platform-updates.service';
import { PLATFORM_UPDATE_COMPONENTS } from '../constants/platform-update-components';

export const PLATFORM_UPDATE_QUEUE = 'platform-update';
export const PLATFORM_UPDATE_JOB = 'run-platform-update';

export interface PlatformUpdateJobData {
  operationId: string;
}

export const PLATFORM_UPDATE_STEPS = [
  {
    step: OperationStep.PLATFORM_UPDATE_PREFLIGHT,
    description: 'Checking what this release moves',
    weight: 10,
  },
  {
    step: OperationStep.PLATFORM_UPDATE_COMPONENTS,
    description: 'Rolling out components',
    weight: 40,
  },
  {
    step: OperationStep.PLATFORM_UPDATE_CONTROL_PLANE,
    description: 'Rolling out the control plane',
    weight: 40,
  },
  {
    step: OperationStep.PLATFORM_UPDATE_VERIFY,
    description: 'Verifying',
    weight: 10,
  },
];

@Injectable()
export class PlatformUpdateRunnerService {
  private readonly logger = new Logger(PlatformUpdateRunnerService.name);

  constructor(
    private readonly platformUpdates: PlatformUpdatesService,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectQueue(PLATFORM_UPDATE_QUEUE)
    private readonly queue: Queue<PlatformUpdateJobData>,
  ) {}

  async findRunning(): Promise<InfrastructureOperationEntity | null> {
    return this.operationRepository.findOne({
      where: {
        operationType: OperationType.UPDATE_PLATFORM,
        status: In([OperationStatus.PENDING, OperationStatus.IN_PROGRESS]),
      },
      order: { createdAt: 'DESC' },
    });
  }

  async history(limit = 20): Promise<InfrastructureOperationEntity[]> {
    return this.operationRepository.find({
      where: { operationType: OperationType.UPDATE_PLATFORM },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Queues the one update. Re-checks the manifest first rather than trusting
   * the version the caller saw: a release can be superseded or withdrawn
   * between the page load and the click, and applying the one the caller
   * *meant* is the only safe reading of the request.
   */
  async start(
    targetVersion: string,
    userId?: string,
  ): Promise<InfrastructureOperationEntity> {
    const running = await this.findRunning();
    if (running) {
      const meta = running.metadata as PlatformUpdateOperationMetadata;
      if (meta.targetVersion === targetVersion) return running;
      throw new ConflictException(
        `An update to ${meta.targetVersion} is already running.`,
      );
    }

    const status = await this.platformUpdates.getStatus(true);
    if (!status.updateAvailable) {
      throw new BadRequestException('This installation is already up to date.');
    }
    if (status.availableVersion !== targetVersion) {
      throw new ConflictException(
        `Release ${targetVersion} is no longer the one on offer; ${status.availableVersion} is. Re-check and try again.`,
      );
    }
    const blocker = status.advisories.find((a) => a.level === 'blocker');
    if (blocker) {
      throw new BadRequestException(`${blocker.title}. ${blocker.detail}`);
    }

    const imageRefs = await this.platformUpdates.imageRefsFor(
      status.components,
    );
    const components: PlatformUpdateOperationMetadata['components'] =
      PLATFORM_UPDATE_COMPONENTS.map((def) => {
        const view = status.components.find((c) => c.key === def.key);
        return {
          key: def.key,
          name: def.name,
          fromVersion: view?.installedVersion ?? null,
          targetVersion: view?.targetVersion ?? '',
          imageRef: imageRefs[def.key] ?? '',
          status: view?.changed ? 'pending' : 'skipped',
        };
      });

    const changed = components.filter((c) => c.status === 'pending');
    if (changed.length === 0) {
      throw new BadRequestException(
        `Release ${targetVersion} moves none of the components on this installation.`,
      );
    }
    const unresolved = changed.filter((c) => !c.imageRef);
    if (unresolved.length > 0) {
      throw new BadRequestException(
        `No image could be resolved for: ${unresolved.map((c) => c.name).join(', ')}. Run system app discovery on the control cluster and try again.`,
      );
    }

    const metadata: PlatformUpdateOperationMetadata = {
      fromVersion: RELEASE.version,
      targetVersion,
      components,
      migrations: status.migrations,
      operationSteps: PLATFORM_UPDATE_STEPS,
    };

    const operation = await this.operationRepository.save(
      this.operationRepository.create({
        operationType: OperationType.UPDATE_PLATFORM,
        status: OperationStatus.PENDING,
        resourceType: 'platform',
        resourceName: `Flui ${targetVersion}`,
        resourceId: targetVersion,
        userId,
        totalSteps: PLATFORM_UPDATE_STEPS.length,
        currentStepIndex: 0,
        currentStepProgress: 0,
        metadata,
      }),
    );

    await this.queue.add(
      PLATFORM_UPDATE_JOB,
      { operationId: operation.id },
      // No retry: the job replaces the process running it, so a second attempt
      // would restart an update that is already half applied.
      { attempts: 1 },
    );
    this.logger.log(
      `Platform update ${RELEASE.version} → ${targetVersion} queued (operation ${operation.id})`,
    );
    return operation;
  }
}
