import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';
import { BackupJobsService } from '../services/backup-jobs.service';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { VolumeBackupsService } from '../../applications/services/volume-backups.service';
import { ApplicationVolumeClaimsService } from '../../applications/services/application-volume-claims.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { VOLUME_COPY_REFUSED } from '../../applications/services/volume-copy-preflight.service';

interface RunVolumeCopyData {
  backupJobId: string;
  operationId?: string;
}

interface VolumeOutcome {
  volume: string;
  reason: string;
}

/**
 * Scheduled copies of an application's volumes, off the cluster.
 *
 * Deliberately `s3-archive` only. A clone's one advantage over an object-store
 * copy is restore speed, and its price on the dedicated storage class is the
 * application's own disk: a nightly clone kept for a week is seven full copies
 * of the volume sitting beside the live one. A clone remains what it always
 * was — a restore point a person takes by hand before doing something risky.
 *
 * Each volume is decided on its own, on every run, because what a volume holds
 * today says nothing about what it held when the policy was written:
 *
 * - nothing is writing, or the volume holds no database → copy it live
 * - it holds a data directory and nobody has consented to the cost of a
 *   consistent copy → **skip that volume and say so**
 *
 * The second branch is the one that matters. Copying a live database on a timer
 * produces an artifact that appears in every listing as protection and will not
 * restore, and a schedule turns one such lie into one per night. A skip that is
 * reported is worse for nobody and honest for everybody.
 */
@Processor(BACKUP_QUEUE)
export class RunVolumeCopyProcessor {
  private readonly logger = new Logger(RunVolumeCopyProcessor.name);

  constructor(
    private readonly jobsService: BackupJobsService,
    private readonly policyRepo: BackupPolicyRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly volumeBackups: VolumeBackupsService,
    private readonly volumeClaims: ApplicationVolumeClaimsService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly encryption: EncryptionService,
  ) {}

  @Process(BACKUP_JOB_TYPES.RUN_VOLUME_COPY)
  async handle(job: Job<RunVolumeCopyData>): Promise<void> {
    const { backupJobId } = job.data;
    const backupJob = await this.jobsService.findById(backupJobId);
    const policy = backupJob.policyId
      ? await this.policyRepo.findById(backupJob.policyId)
      : null;
    if (!policy) throw new Error(`Policy for job ${backupJobId} not found`);

    const appId = policy.scopeSelector?.applicationIds?.[0];
    if (!appId) {
      throw new Error('A volume-copy policy targets exactly one application');
    }
    const app = await this.applicationsRepo.findById(appId);
    if (!app) throw new Error(`Application ${appId} not found`);

    const primary = this.policyRepoPrimary(policy);
    const destination = await this.destRepo.findById(primary);
    if (!destination) throw new Error('Primary destination not found');

    await this.jobsService.update(backupJobId, {
      status: BackupJobStatus.RUNNING,
      startedAt: new Date(),
    });

    const volumes = await this.resolveVolumes(app, policy);
    const { copied, needsDecision, failed } = await this.copyEach(
      volumes,
      app,
      policy,
      destination.id,
    );

    // A run that copied everything it was allowed to copy did its job, even if
    // that was nothing: the volumes it left alone are waiting on a person, not
    // on Flui. Only a real error makes the run a failure.
    const status = this.statusOf(copied, needsDecision, failed);

    await this.jobsService.update(backupJobId, {
      status,
      finishedAt: new Date(),
      metadata: {
        // Named so nobody reads N artifacts from one run as an application-wide
        // point in time. They are N independent copies taken in sequence; an
        // app-wide consistent moment is a larger outage nobody has asked for.
        consistencyGroup: 'volume',
        volumesCopied: copied,
        volumesNeedingDecision: needsDecision,
        volumesFailed: failed,
      },
      ...(failed.length > 0 || needsDecision.length > 0
        ? {
            errorMessage: [...failed, ...needsDecision]
              .map((v) => `${v.volume}: ${v.reason}`)
              .join('; ')
              .slice(0, 500),
          }
        : {}),
    });

    this.logger.log(
      `[volume-copy] policy=${policy.id} app=${app.slug} copied=${copied.length} ` +
        `needs-decision=${needsDecision.length} failed=${failed.length}`,
    );
  }

  /**
   * Two different things, deliberately not one list. A volume awaiting a
   * decision is a working system with a question outstanding; a volume that
   * errored is a fault. Collapsing them either pages someone about the first
   * or hides the second.
   */
  private async copyEach(
    volumes: string[],
    app: { id: string; slug: string },
    policy: { id: string; userId: string; retentionDays?: number | null },
    destinationId: string,
  ): Promise<{
    copied: string[];
    needsDecision: VolumeOutcome[];
    failed: VolumeOutcome[];
  }> {
    const copied: string[] = [];
    const needsDecision: VolumeOutcome[] = [];
    const failed: VolumeOutcome[] = [];

    for (const volumeName of volumes) {
      try {
        await this.volumeBackups.createForApp({
          applicationId: app.id,
          volumeName,
          destinationId,
          userId: policy.userId,
          description: 'scheduled',
          policyId: policy.id,
          // Without this the copy is indistinguishable from one a person took,
          // and the reaper leaves those alone — so a nightly schedule would
          // accumulate forever, which is what pruning exists to prevent.
          expiresAt: policy.retentionDays
            ? new Date(Date.now() + policy.retentionDays * 86_400_000)
            : undefined,
        });
        copied.push(volumeName);
      } catch (err: any) {
        const code = err?.response?.code ?? err?.code;
        if (code === VOLUME_COPY_REFUSED) {
          // Not a failure of this run: a decision nobody has made yet. It is
          // recorded per volume so `backup status` can ask for that decision
          // instead of the run looking either healthy or broken.
          needsDecision.push({
            volume: volumeName,
            reason: `holds a ${err.response.dataDirectoryDetected} data directory and is being written to`,
          });
          continue;
        }
        failed.push({
          volume: volumeName,
          reason: err?.message ?? String(err),
        });
      }
    }

    return { copied, needsDecision, failed };
  }

  private statusOf(
    copied: string[],
    needsDecision: VolumeOutcome[],
    failed: VolumeOutcome[],
  ): BackupJobStatus {
    if (failed.length > 0) {
      return copied.length === 0
        ? BackupJobStatus.FAILED
        : BackupJobStatus.PARTIALLY_COMPLETED;
    }
    return needsDecision.length > 0
      ? BackupJobStatus.PARTIALLY_COMPLETED
      : BackupJobStatus.COMPLETED;
  }

  /**
   * Every volume the application has, minus any the policy excludes.
   *
   * Re-read on every run rather than frozen at creation, so a volume added
   * later is protected without anyone remembering to come back. That is safe
   * precisely because the per-volume ladder above decides each one on its own:
   * a new uploads volume is copied, a new data directory is skipped and
   * reported, and neither outcome depends on a list written months ago.
   */
  private async resolveVolumes(
    app: { id: string; clusterId: string; k8sNamespace: string; slug: string },
    policy: {
      scopeSelector?: Record<string, any>;
      metadata?: Record<string, any>;
    },
  ): Promise<string[]> {
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(`Cluster ${app.clusterId} has no kubeconfig`);
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const claims = await this.volumeClaims.resolveForApplication(
      kubeconfig,
      app as any,
      [],
      // A copy of a copy protects nothing and doubles the bill.
      { excludeCopies: true },
    );
    const excluded = new Set<string>(policy.metadata?.excludeVolumes ?? []);
    return claims
      .map((c) => c.name)
      .filter((name): name is string => !!name && !excluded.has(name));
  }

  private policyRepoPrimary(policy: {
    destinations?: Array<{ destinationId: string; role: string }>;
  }): string {
    const primary = (policy.destinations ?? []).find(
      (d) => d.role === 'primary',
    );
    if (!primary) throw new Error('Policy has no PRIMARY destination');
    return primary.destinationId;
  }
}
