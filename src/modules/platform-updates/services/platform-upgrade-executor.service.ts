import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RELEASE } from '../../../config/release.config';
import {
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { BackupJobEntity } from '../../backups/entities/backup-job.entity';
import { BackupPolicyEntity } from '../../backups/entities/backup-policy.entity';
import { BackupJobStatus } from '../../backups/enums/backup-job.enum';
import { BackupJobsService } from '../../backups/services/backup-jobs.service';
import { ManifestRefreshService } from './manifest-refresh.service';
import { ImageRolloutService } from './image-rollout.service';
import { PlatformUpdatesService } from './platform-updates.service';
import { K3sUpgradeService } from './k3s-upgrade.service';
import { DeclaredImageService } from './declared-image.service';
import { PlatformUpgradeChecksService } from './platform-upgrade-checks.service';
import { PlatformUpgradeRecordsService } from './platform-upgrade-records.service';
import { PlatformComponentKey } from '../constants/platform-update-components';
import {
  PlatformUpgradeMetadata,
  UpgradePhaseCluster,
  UpgradePhaseKey,
} from '../interfaces/platform-upgrade.interface';
import {
  PHASE_ORDER,
  approvalCovers,
  phaseBudgetMs,
  writableFiles,
} from '../utils/platform-upgrade.util';
import {
  PHASE_STEP,
  controlImagesToDeclare,
  failedMetadata,
  isOverdue,
  phaseBudgetContext,
  phaseOf,
} from '../utils/upgrade-state.util';
import { K3S_CONTROLLER_WAIT_MS } from '../utils/k3s-plans.util';
import { failingChecksMessage } from '../utils/upgrade-checks.util';

const POLL_MS = 10_000;
const MANIFEST_ROLLOUT_WAIT = { timeoutMs: 5 * 60_000, settleMs: 30_000 };

class PhaseFailure extends Error {
  constructor(
    readonly phase: UpgradePhaseKey,
    message: string,
    readonly clusterId?: string,
  ) {
    super(message);
  }
}

type Outcome = 'done' | 'parked';

function backupEndedMessage(
  jobId: string,
  job: { status: BackupJobStatus; errorMessage?: string } | null,
): string {
  const reason = job?.errorMessage ? `: ${job.errorMessage}` : '';
  return `The platform backup ${jobId} ended ${job?.status ?? 'missing'}${reason}.`;
}

/**
 * Runs a planned platform update phase by phase. Each phase first checks
 * whether its target is already reached, so running it again — after a crash,
 * a resume, or the API replacing itself — repeats nothing that is done.
 *
 * Nothing is rolled back: a failure records the phase and cluster it reached
 * and the fixed guidance for that phase.
 */
@Injectable()
export class PlatformUpgradeExecutorService {
  private readonly logger = new Logger(PlatformUpgradeExecutorService.name);
  private readonly active = new Set<string>();
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  runningVersion: string = RELEASE.version;

  constructor(
    @InjectRepository(BackupJobEntity)
    private readonly backupJobRepository: Repository<BackupJobEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRepository: Repository<BackupPolicyEntity>,
    private readonly records: PlatformUpgradeRecordsService,
    private readonly backupJobs: BackupJobsService,
    private readonly manifests: ManifestRefreshService,
    private readonly images: ImageRolloutService,
    private readonly platformUpdates: PlatformUpdatesService,
    private readonly k3s: K3sUpgradeService,
    private readonly declaredImages: DeclaredImageService,
    private readonly verification: PlatformUpgradeChecksService,
  ) {}

  async execute(operationId: string): Promise<void> {
    if (this.active.has(operationId)) return;
    this.active.add(operationId);
    try {
      await this.walk(operationId);
    } finally {
      this.active.delete(operationId);
    }
  }

  private async walk(operationId: string): Promise<void> {
    const start = await this.records.load(operationId);
    if (!start) return;
    if (!this.mayWalk(start.operation.status, start.metadata)) return;
    await this.records.mutate(operationId, (_m, op) => {
      op.status = OperationStatus.IN_PROGRESS;
      op.startedAt = op.startedAt ?? new Date(this.now());
    });

    for (const key of PHASE_ORDER) {
      const current = await this.records.load(operationId);
      if (current?.operation.status !== OperationStatus.IN_PROGRESS) return;
      const phase = phaseOf(current.metadata, key);
      if (phase.status === 'done' || phase.status === 'skipped') continue;

      await this.startPhase(operationId, key, current.metadata);
      let outcome: Outcome;
      try {
        outcome = await this.runPhase(key, operationId);
      } catch (error) {
        const failure =
          error instanceof PhaseFailure
            ? error
            : new PhaseFailure(key, (error as Error).message);
        await this.fail(operationId, failure);
        return;
      }
      if (outcome === 'parked') return;
      await this.records.mutate(operationId, (m) => {
        const p = phaseOf(m, key);
        p.status = 'done';
        p.finishedAt = new Date(this.now()).toISOString();
        p.deadlineAt = undefined;
      });
    }
    await this.complete(operationId);
  }

  /**
   * Whether this operation waits for a newer API than this one: during the
   * rollout an old copy may be the one handed the continuation.
   */
  async waitsForNewerApi(operationId: string): Promise<boolean> {
    const record = await this.records.load(operationId);
    if (!record) return false;
    const { status } = record.operation;
    return (
      (status === OperationStatus.PENDING ||
        status === OperationStatus.IN_PROGRESS) &&
      Boolean(record.metadata.awaitingSelfRestart) &&
      this.runningVersion !== record.metadata.targetVersion
    );
  }

  private mayWalk(
    status: OperationStatus,
    metadata: PlatformUpgradeMetadata,
  ): boolean {
    if (
      status !== OperationStatus.PENDING &&
      status !== OperationStatus.IN_PROGRESS
    ) {
      return false;
    }
    return !(
      metadata.awaitingSelfRestart &&
      this.runningVersion !== metadata.targetVersion
    );
  }

  private runPhase(
    key: UpgradePhaseKey,
    operationId: string,
  ): Promise<Outcome> {
    switch (key) {
      case 'backup':
        return this.backup(operationId);
      case 'manifests':
        return this.manifestsPhase(operationId);
      case 'images':
        return this.imagesPhase(operationId);
      case 'k3s':
        return this.k3sPhase(operationId);
      case 'verify':
        return this.verify(operationId);
    }
  }

  private async startPhase(
    operationId: string,
    key: UpgradePhaseKey,
    metadata: PlatformUpgradeMetadata,
  ): Promise<void> {
    const budget = phaseBudgetMs(key, phaseBudgetContext(key, metadata));
    const at = new Date(this.now());
    await this.records.mutate(operationId, (m, op) => {
      const p = phaseOf(m, key);
      p.status = 'running';
      p.startedAt = p.startedAt ?? at.toISOString();
      p.deadlineAt = new Date(at.getTime() + budget).toISOString();
      op.currentStep = PHASE_STEP[key].step;
      op.currentStepIndex = PHASE_STEP[key].index;
      op.progress = PHASE_STEP[key].progress;
    });
  }

  private overdue(key: UpgradePhaseKey, metadata: PlatformUpgradeMetadata) {
    return isOverdue(phaseOf(metadata, key), this.now());
  }

  private async backup(operationId: string): Promise<Outcome> {
    const jobId = await this.backupJobFor(operationId);
    for (;;) {
      const job = await this.backupJobRepository.findOne({
        where: { id: jobId },
      });
      if (job?.status === BackupJobStatus.COMPLETED) return 'done';
      if (!job || this.endedIncomplete(job.status)) {
        throw new PhaseFailure('backup', backupEndedMessage(jobId, job));
      }
      const current = await this.records.load(operationId);
      if (current && this.overdue('backup', current.metadata)) {
        throw new PhaseFailure(
          'backup',
          `The platform backup ${jobId} did not finish in time.`,
        );
      }
      await this.sleep(POLL_MS);
    }
  }

  private async backupJobFor(operationId: string): Promise<string> {
    const { operation, metadata } = (await this.records.load(operationId))!;
    const phase = phaseOf(metadata, 'backup');
    if (phase.backupJobId) {
      const recorded = await this.backupJobRepository.findOne({
        where: { id: phase.backupJobId },
      });
      if (recorded && !this.endedIncomplete(recorded.status)) {
        return phase.backupJobId;
      }
    }
    if (!phase.policyId) {
      throw new PhaseFailure('backup', 'No platform backup is set up.');
    }
    const policy = await this.policyRepository.findOne({
      where: { id: phase.policyId },
    });
    const userId = operation.userId ?? policy?.userId;
    if (!userId) {
      throw new PhaseFailure(
        'backup',
        'There is nobody to run the platform backup as: the update records no user and the backup policy has no owner.',
      );
    }
    const job = await this.backupJobs.createOnDemand(userId, {
      policyId: phase.policyId,
      metadata: { platformUpdate: operationId },
    });
    await this.records.mutate(operationId, (m) => {
      phaseOf(m, 'backup').backupJobId = job.id;
    });
    return job.id;
  }

  private endedIncomplete(status: BackupJobStatus): boolean {
    return (
      status === BackupJobStatus.FAILED ||
      status === BackupJobStatus.CANCELLED ||
      status === BackupJobStatus.PARTIALLY_COMPLETED
    );
  }

  private async manifestsPhase(operationId: string): Promise<Outcome> {
    const { metadata } = (await this.records.load(operationId))!;
    const clusters = phaseOf(metadata, 'manifests').clusters ?? [];
    for (const cluster of clusters) {
      if (cluster.status === 'done' || cluster.status === 'skipped') continue;
      const mark = (patch: Partial<UpgradePhaseCluster>) =>
        this.records.markCluster(
          operationId,
          'manifests',
          cluster.clusterId,
          patch,
        );
      await mark({ status: 'running' });
      try {
        const fresh = await this.manifests.plan({
          ref: metadata.bootstrapRef,
          clusterId: cluster.clusterId,
        });
        const files = writableFiles(fresh.entries);
        if (files.length === 0) {
          await mark({ status: 'done', wrote: [] });
          continue;
        }
        if (!approvalCovers(cluster.approved ?? [], files)) {
          throw new Error(
            `The manifests on ${cluster.clusterName} changed since the plan: ${files.map((f) => f.name).join(', ')} would be written. Plan the update again.`,
          );
        }
        const result = await this.manifests.apply({
          ref: metadata.bootstrapRef,
          clusterId: cluster.clusterId,
          planId: fresh.planId,
          awaitRollout: MANIFEST_ROLLOUT_WAIT,
        });
        await mark({
          status: 'done',
          wrote: result.wrote,
          backupPath: result.backupPath,
          planId: fresh.planId,
        });
      } catch (error) {
        throw new PhaseFailure(
          'manifests',
          `${cluster.clusterName}: ${(error as Error).message}`,
          cluster.clusterId,
        );
      }
    }
    return 'done';
  }

  private async imagesPhase(operationId: string): Promise<Outcome> {
    const { metadata } = (await this.records.load(operationId))!;
    const appIds = await this.platformUpdates.componentAppIds();
    const status = await this.platformUpdates.getStatus(true);
    const running = (key: string) =>
      status.components.find((c) => c.key === key)?.installedVersion ?? null;

    for (const component of metadata.components) {
      if (component.key === 'fluiApi') continue;
      if (component.status === 'done' || component.status === 'skipped')
        continue;
      if (running(component.key) === component.targetVersion) {
        await this.records.markComponent(operationId, component.key, 'done');
        continue;
      }
      await this.records.markComponent(operationId, component.key, 'running');
      await this.images.rollout(
        component,
        appIds.get(component.key as PlatformComponentKey),
      );
      await this.records.markComponent(operationId, component.key, 'done');
    }

    const api = metadata.components.find((c) => c.key === 'fluiApi');
    if (!api || api.status === 'done' || api.status === 'skipped')
      return 'done';
    if (this.runningVersion === api.targetVersion) {
      await this.records.markComponent(operationId, 'fluiApi', 'done');
      return 'done';
    }
    const restartBudget = phaseBudgetMs('images', { components: 0 });
    await this.records.mutate(operationId, (m, op) => {
      m.components = m.components.map((c) =>
        c.key === 'fluiApi' ? { ...c, status: 'running' as const } : c,
      );
      m.awaitingSelfRestart = true;
      m.awaitingSince = new Date(this.now()).toISOString();
      const p = phaseOf(m, 'images');
      const extended = this.now() + restartBudget;
      if (!p.deadlineAt || Date.parse(p.deadlineAt) < extended) {
        p.deadlineAt = new Date(extended).toISOString();
      }
      op.currentStep = OperationStep.PLATFORM_UPDATE_CONTROL_PLANE;
    });
    await this.images.replaceControlPlane(api, appIds.get('fluiApi'));
    return 'parked';
  }

  private async k3sPhase(operationId: string): Promise<Outcome> {
    const { metadata } = (await this.records.load(operationId))!;
    const target = metadata.k3sVersion;
    if (!target) return 'done';
    for (const cluster of phaseOf(metadata, 'k3s').clusters ?? []) {
      if (cluster.status === 'done' || cluster.status === 'skipped') continue;
      await this.records.markCluster(operationId, 'k3s', cluster.clusterId, {
        status: 'running',
      });
      try {
        const ready = await this.awaitController(cluster.clusterId, target);
        if (ready && cluster.clusterType === 'control') {
          await this.declareControlImages(operationId);
        }
        if (ready) await this.k3s.run(operationId, cluster.clusterId, target);
        await this.records.markCluster(operationId, 'k3s', cluster.clusterId, {
          status: 'done',
        });
      } catch (error) {
        throw new PhaseFailure(
          'k3s',
          `${cluster.clusterName}: ${(error as Error).message}`,
          cluster.clusterId,
        );
      }
    }
    return 'done';
  }

  /**
   * K3s re-applies every file in the manifest directory when it starts, and the
   * manifests phase wrote the tags that ran before the images moved: restarting
   * the control now would hand the API back its old build mid-update.
   */
  private async declareControlImages(operationId: string): Promise<void> {
    const { metadata } = (await this.records.load(operationId))!;
    const { moved, previous } = controlImagesToDeclare(metadata);
    for (const component of moved) {
      const result = await this.declaredImages.pin(component.imageRef, {
        images: previous,
      });
      if (!result.pinned) {
        throw new Error(
          `${component.name} ${component.targetVersion} could not be declared on the control master, so restarting K3s there would bring back the image it declares now: ${result.reason ?? 'unknown reason'}.`,
        );
      }
    }
  }

  /**
   * The manifests phase may have just installed the upgrade controller; give it
   * time to come up. False when the cluster is already at the target.
   */
  private async awaitController(
    clusterId: string,
    target: string,
  ): Promise<boolean> {
    const until = this.now() + K3S_CONTROLLER_WAIT_MS;
    for (;;) {
      const [plan] = await this.k3s.plan(clusterId, target);
      if (!plan || plan.upToDate) return false;
      const others = plan.blockers.filter(
        (b) => !b.includes('system-upgrade-controller'),
      );
      if (others.length > 0) throw new Error(others.join(' '));
      if (plan.blockers.length === 0) return true;
      if (this.now() > until) throw new Error(plan.blockers.join(' '));
      await this.sleep(POLL_MS);
    }
  }

  private async verify(operationId: string): Promise<Outcome> {
    for (;;) {
      const { metadata } = (await this.records.load(operationId))!;
      const checks = await this.verification.checks(metadata);
      await this.records.mutate(operationId, (m) => {
        phaseOf(m, 'verify').checks = checks;
      });
      const failing = checks.filter((c) => !c.ok);
      if (failing.length === 0) return 'done';
      if (
        this.overdue('verify', (await this.records.load(operationId))!.metadata)
      ) {
        throw new PhaseFailure('verify', failingChecksMessage(failing));
      }
      await this.sleep(POLL_MS);
    }
  }

  private async fail(
    operationId: string,
    failure: PhaseFailure,
  ): Promise<void> {
    const now = new Date(this.now());
    this.logger.error(
      `Platform update ${operationId} stopped in ${failure.phase}: ${failure.message}`,
    );
    await this.records.mutate(operationId, (m, op) => {
      const next = failedMetadata(
        m,
        failure.phase,
        failure.message,
        this.runningVersion,
        now,
        failure.clusterId,
      );
      Object.assign(m, next);
      op.status = OperationStatus.FAILED;
      op.errorMessage = `${failure.message} ${next.guidance ?? ''}`.trim();
      op.completedAt = now;
    });
  }

  private async complete(operationId: string): Promise<void> {
    await this.records.mutate(operationId, (m, op) => {
      op.status = OperationStatus.COMPLETED;
      op.progress = 100;
      op.currentStep = OperationStep.PLATFORM_UPDATE_VERIFY;
      op.currentStepIndex = PHASE_ORDER.length - 1;
      op.completedAt = new Date(this.now());
      m.awaitingSelfRestart = false;
      m.message = `Updated to Flui ${m.targetVersion}.`;
    });
    this.logger.log(`Platform update ${operationId} completed.`);
  }
}
