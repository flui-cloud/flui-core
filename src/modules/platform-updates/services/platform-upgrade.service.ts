import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { RELEASE } from '../../../config/release.config';
import {
  ClusterEntity,
  ClusterStatus,
  isControlClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { BackupPolicyEntity } from '../../backups/entities/backup-policy.entity';
import { BackupEngineClass } from '../../backups/enums/backup-engine-class.enum';
import { AuditService } from '../../audit/audit.service';
import { PlatformUpdatesService } from './platform-updates.service';
import { ReleaseManifestService } from './release-manifest.service';
import { ManifestRefreshService } from './manifest-refresh.service';
import { K3sUpgradeService } from './k3s-upgrade.service';
import { PlatformUpdateRunnerService } from './platform-update-runner.service';
import {
  PLATFORM_UPDATE_QUEUE,
  PlatformUpdateJobData,
  enqueueUpgrade,
} from '../constants/platform-update-queue';
import { PlatformReleaseEntry } from '../interfaces/release-manifest.interface';
import {
  PlatformUpgradeMetadata,
  PlatformUpgradePlan,
  UpgradePlanAdvisory,
  UpgradePlanCluster,
  UpgradePlanPhase,
  WITHOUT_BACKUP_ACKNOWLEDGEMENT,
  isUpgradeMetadata,
} from '../interfaces/platform-upgrade.interface';
import {
  isAcknowledged,
  manifestOrder,
  upgradeDigest,
} from '../utils/platform-upgrade.util';
import { resumedMetadata } from '../utils/upgrade-state.util';
import {
  ClusterRef,
  NO_K3S_PHASE,
  UPGRADE_STEPS,
  VERIFY_PHASE,
  backupPhaseFor,
  imagePhaseFor,
  k3sPhaseFor,
  leftAloneAdvisories,
  manifestClusterFor,
  manifestPhaseFor,
  metadataFor,
  releaseAssessment,
  unreadableManifestCluster,
  updateAdvisories,
} from '../utils/upgrade-plan.util';

export interface UpgradeActor {
  userId?: string | null;
  email?: string | null;
  actorKind?: string | null;
  actorKeyId?: string | null;
}

export interface ApplyUpgradeInput {
  targetVersion: string;
  planId: string;
  withoutBackup?: boolean;
  acknowledgement?: string;
}

/**
 * One update for the whole installation: back up, bring the system manifests
 * forward, move the platform images, upgrade K3s and check the result — as one
 * operation, planned first and applied only as planned.
 *
 * The plan id covers every phase, so applying refuses a plan whose clusters,
 * files, images or K3s path moved since it was read.
 */
@Injectable()
export class PlatformUpgradeService {
  private readonly logger = new Logger(PlatformUpgradeService.name);

  constructor(
    private readonly platformUpdates: PlatformUpdatesService,
    private readonly releases: ReleaseManifestService,
    private readonly manifests: ManifestRefreshService,
    private readonly k3s: K3sUpgradeService,
    private readonly runner: PlatformUpdateRunnerService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRepository: Repository<BackupPolicyEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectQueue(PLATFORM_UPDATE_QUEUE)
    private readonly queue: Queue<PlatformUpdateJobData>,
    private readonly audit: AuditService,
  ) {}

  async plan(targetVersion?: string): Promise<PlatformUpgradePlan> {
    const status = await this.platformUpdates.getStatus(true);
    const target = targetVersion ?? status.availableVersion ?? '';
    const { blockers: releaseBlockers, advisories } = releaseAssessment(
      status,
      target,
    );

    const release = await this.release(target);
    if (target && !release && releaseBlockers.length === 0) {
      releaseBlockers.push({
        phase: 'release',
        message: `Release ${target} is not in the published release manifest.`,
      });
    }
    const bootstrapRef = release?.bootstrapRef ?? RELEASE.bootstrapRef;
    const k3sVersion = release?.k3s?.version ?? null;
    const clusters = await this.clusters();

    const backup = await this.backupPhase();
    const manifests = await this.manifestPhase(
      clusters,
      bootstrapRef,
      advisories,
    );
    const images = await this.imagePhase(status);
    const k3s = await this.k3sPhase(k3sVersion, manifests);
    const phases = [backup, manifests, images, k3s, VERIFY_PHASE];

    if (
      releaseBlockers.length === 0 &&
      !manifests.willRun &&
      !images.willRun &&
      !k3s.willRun
    ) {
      releaseBlockers.push({
        phase: 'release',
        message: `Release ${target} changes nothing on this installation.`,
      });
    }
    const migrations = release?.migrations ?? status.migrations;
    advisories.push(...updateAdvisories(migrations, k3s));

    const blockers = [...releaseBlockers, ...phases.flatMap((p) => p.blockers)];
    const planId = upgradeDigest({
      targetVersion: target,
      bootstrapRef,
      k3sVersion,
      phases,
      blockers,
    });
    return {
      planId,
      fromVersion: RELEASE.version,
      targetVersion: target,
      bootstrapRef,
      k3sVersion,
      migrations,
      phases,
      advisories,
      blockers,
      applicable: blockers.every((b) => b.overridable),
      acknowledgement: WITHOUT_BACKUP_ACKNOWLEDGEMENT,
    };
  }

  async apply(
    input: ApplyUpgradeInput,
    actor: UpgradeActor,
  ): Promise<InfrastructureOperationEntity> {
    const running = await this.runner.findRunning();
    if (running) {
      const meta = running.metadata as PlatformUpgradeMetadata;
      if (isUpgradeMetadata(meta) && meta.planId === input.planId) {
        return running;
      }
      throw new ConflictException(
        `An update to ${meta.targetVersion} is already running.`,
      );
    }

    const plan = await this.plan(input.targetVersion);
    if (plan.planId !== input.planId) {
      throw new ConflictException(
        `The plan changed since it was read (${input.planId} → ${plan.planId}). Plan the update again and apply the new plan id.`,
      );
    }
    const hard = plan.blockers.filter((b) => !b.overridable);
    if (hard.length > 0) {
      throw new BadRequestException(hard.map((b) => b.message).join(' '));
    }
    const withoutBackup = input.withoutBackup === true;
    if (withoutBackup && !isAcknowledged(input.acknowledgement)) {
      throw new BadRequestException(
        `Going without a backup needs the acknowledgement: "${WITHOUT_BACKUP_ACKNOWLEDGEMENT}"`,
      );
    }
    if (!withoutBackup && plan.blockers.some((b) => b.overridable)) {
      throw new BadRequestException(
        `${plan.blockers.find((b) => b.overridable)?.message} Set up a platform backup, or apply without one and acknowledge: "${WITHOUT_BACKUP_ACKNOWLEDGEMENT}"`,
      );
    }

    const metadata = metadataFor(plan, withoutBackup);
    const recorded = await this.runner.exclusive(async (tx) => {
      const other = await tx.findRunning();
      if (other) {
        const meta = other.metadata as PlatformUpgradeMetadata;
        if (isUpgradeMetadata(meta) && meta.planId === input.planId) {
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
          resourceName: `Flui ${plan.targetVersion}`,
          resourceId: plan.targetVersion,
          userId: actor.userId ?? undefined,
          totalSteps: UPGRADE_STEPS.length,
          currentStepIndex: 0,
          currentStepProgress: 0,
          metadata,
        }),
      );
      return { operation, created: true };
    });
    if (!recorded.created) return recorded.operation;
    const { operation } = recorded;

    if (withoutBackup) {
      await this.audit.record({
        userId: actor.userId ?? null,
        email: actor.email ?? null,
        actorKind: actor.actorKind ?? null,
        actorKeyId: actor.actorKeyId ?? null,
        action: 'platform update without backup',
        target: {
          operationId: operation.id,
          targetVersion: plan.targetVersion,
          acknowledgement: WITHOUT_BACKUP_ACKNOWLEDGEMENT,
        },
        outcome: 'ok',
        permission: 'platform:update',
        dataAccess: false,
      });
    }

    await enqueueUpgrade(this.queue, operation.id);
    this.logger.log(
      `Platform upgrade ${RELEASE.version} → ${plan.targetVersion} queued (operation ${operation.id}, plan ${plan.planId}${withoutBackup ? ', without backup' : ''})`,
    );
    return operation;
  }

  /** Starts a stopped phased update again from the phase and cluster it reached. */
  async resume(operationId: string): Promise<InfrastructureOperationEntity> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId, operationType: OperationType.UPDATE_PLATFORM },
    });
    if (!operation) {
      throw new NotFoundException(`Platform update ${operationId} not found.`);
    }
    const metadata = operation.metadata;
    if (!isUpgradeMetadata(metadata)) {
      throw new BadRequestException(
        'Only a planned update can be resumed. Start this one again from Updates.',
      );
    }
    if (operation.status === OperationStatus.COMPLETED) {
      throw new ConflictException('This update already finished.');
    }
    if (
      metadata.awaitingSelfRestart &&
      operation.status === OperationStatus.IN_PROGRESS
    ) {
      throw new ConflictException(
        'The API is being replaced; the new one continues this update on its own.',
      );
    }
    const job = await this.queue.getJob(`platform-upgrade:${operationId}`);
    const state = job ? await job.getState() : null;
    if (state === 'active' || state === 'waiting' || state === 'delayed') {
      throw new ConflictException(
        'This update is still running in the worker; it cannot be resumed until that run ends. Follow it with `flui env upgrade`.',
      );
    }

    const saved = await this.runner.exclusive(async (tx) => {
      const running = await tx.findRunning();
      if (running && running.id !== operationId) {
        throw new ConflictException(
          `Another update, to ${(running.metadata as PlatformUpgradeMetadata).targetVersion}, is running.`,
        );
      }
      operation.status = OperationStatus.IN_PROGRESS;
      operation.errorMessage = null as unknown as string;
      operation.completedAt = null as unknown as Date;
      operation.metadata = resumedMetadata(metadata);
      return tx.save(operation);
    });
    await enqueueUpgrade(this.queue, operationId);
    return saved;
  }

  private async release(
    version: string,
  ): Promise<PlatformReleaseEntry | undefined> {
    if (!version) return undefined;
    return this.releases
      .getManifest()
      .then((m) => m.manifest.releases.find((r) => r.version === version))
      .catch(() => undefined);
  }

  private async clusters(): Promise<ClusterRef[]> {
    const rows = await this.clusterRepository.find({
      where: { status: ClusterStatus.READY },
      order: { createdAt: 'ASC' },
    });
    return rows
      .filter((c) => c.kubeconfigEncrypted)
      .map((c) => ({
        id: c.id,
        name: c.name,
        clusterType: isControlClusterType(c.clusterType)
          ? ('control' as const)
          : ('workload' as const),
      }));
  }

  private async backupPhase(): Promise<UpgradePlanPhase> {
    const policy = await this.policyRepository.findOne({
      where: { engineClass: BackupEngineClass.PLATFORM, enabled: true },
      order: { updatedAt: 'DESC' },
    });
    return backupPhaseFor(policy);
  }

  private async manifestPhase(
    clusters: ClusterRef[],
    ref: string,
    advisories: UpgradePlanAdvisory[],
  ): Promise<UpgradePlanPhase> {
    const out: UpgradePlanCluster[] = [];
    for (const cluster of manifestOrder(clusters)) {
      try {
        const plan = await this.manifests.plan({ ref, clusterId: cluster.id });
        advisories.push(...leftAloneAdvisories(cluster, plan.entries));
        out.push(manifestClusterFor(cluster, plan));
      } catch (error) {
        out.push(unreadableManifestCluster(cluster, (error as Error).message));
      }
    }
    return manifestPhaseFor(out);
  }

  private async imagePhase(
    status: Awaited<ReturnType<PlatformUpdatesService['getStatus']>>,
  ): Promise<UpgradePlanPhase> {
    const refs = await this.platformUpdates.imageRefsFor(status.components);
    return imagePhaseFor(status, refs);
  }

  private async k3sPhase(
    target: string | null,
    manifests: UpgradePlanPhase,
  ): Promise<UpgradePlanPhase> {
    if (!target) return NO_K3S_PHASE;
    const plans = await this.k3s.plan(undefined, target);
    return k3sPhaseFor(target, plans, manifests);
  }
}
