import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
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
import { ReleaseManifestService } from './release-manifest.service';
import { nonImageReasons } from '../utils/platform-upgrade.util';
import {
  PLATFORM_UPDATE_JOB,
  PLATFORM_UPDATE_QUEUE,
  PlatformUpdateJobData,
} from '../constants/platform-update-queue';

export {
  PLATFORM_UPDATE_QUEUE,
  PLATFORM_UPDATE_JOB,
  PLATFORM_UPGRADE_JOB,
  enqueueUpgrade,
} from '../constants/platform-update-queue';
export type { PlatformUpdateJobData } from '../constants/platform-update-queue';

/** Held for the moment an update is recorded, across every API pod. */
const START_LOCK = '7318229150001';

export interface UpdateTransaction {
  findRunning(): Promise<InfrastructureOperationEntity | null>;
  save(
    operation: InfrastructureOperationEntity,
  ): Promise<InfrastructureOperationEntity>;
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
    @Optional() private readonly releases?: ReleaseManifestService,
    @Optional()
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository?: Repository<ClusterEntity>,
  ) {}

  async findRunning(): Promise<InfrastructureOperationEntity | null> {
    return this.runningIn(this.operationRepository);
  }

  /**
   * Looking for a running update and recording one are a single step: without
   * the lock, two requests arriving together both find none and both start.
   */
  async exclusive<T>(work: (tx: UpdateTransaction) => Promise<T>): Promise<T> {
    return this.operationRepository.manager.transaction(async (em) => {
      const rows: Array<{ locked?: boolean }> = await em.query(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [START_LOCK],
      );
      if (!rows?.[0]?.locked) {
        throw new ConflictException(
          'Another platform update is being started at this moment. Look at the running update, or try again.',
        );
      }
      const repository = em.getRepository(InfrastructureOperationEntity);
      return work({
        findRunning: () => this.runningIn(repository),
        save: (operation) => repository.save(operation),
      });
    });
  }

  private runningIn(
    repository: Repository<InfrastructureOperationEntity>,
  ): Promise<InfrastructureOperationEntity | null> {
    return repository.findOne({
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
    await this.assertImageOnly(targetVersion);

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

    const recorded = await this.exclusive(async (tx) => {
      const other = await tx.findRunning();
      if (other) {
        const meta = other.metadata as PlatformUpdateOperationMetadata;
        if (meta.targetVersion === targetVersion) {
          return { operation: other, created: false };
        }
        throw new ConflictException(
          `An update to ${meta.targetVersion} is already running.`,
        );
      }
      const operation = await tx.save(
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
      return { operation, created: true };
    });
    if (!recorded.created) return recorded.operation;
    const { operation } = recorded;

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

  /** What every ready cluster was last seen running; unknown counts as behind. */
  private async observedK3s(): Promise<Array<string | null>> {
    if (!this.clusterRepository) return [];
    const clusters = await this.clusterRepository.find({
      where: { status: ClusterStatus.READY },
    });
    return clusters.map((c) => c.k3sVersion ?? null);
  }

  /**
   * A release that also upgrades K3s or rewrites manifests has phases this
   * path does not run; applying only its images would leave the rest behind
   * with nobody told.
   */
  private async assertImageOnly(targetVersion: string): Promise<void> {
    if (!this.releases) return;
    const release = await this.releases
      .getManifest()
      .then((m) => m.manifest.releases.find((r) => r.version === targetVersion))
      .catch(() => undefined);
    if (!release) return;
    const reasons = nonImageReasons(release, await this.observedK3s());
    if (reasons.length === 0) return;
    throw new BadRequestException(
      `Release ${targetVersion} does more than move images: ${reasons.join('; ')}. Plan it first (POST /platform/updates/plan, or \`flui env upgrade\`) and apply that plan.`,
    );
  }
}
