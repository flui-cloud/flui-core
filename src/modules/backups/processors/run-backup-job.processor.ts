import { Processor, Process, InjectQueue } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Queue, Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  BackupJobsService,
  RunBackupJobData,
} from '../services/backup-jobs.service';
import { BackupPoliciesService } from '../services/backup-policies.service';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { VeleroClientService } from '../services/velero-client.service';
import { VeleroInstallerService } from '../services/velero-installer.service';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';
import { BackupScope } from '../enums/backup-scope.enum';

@Processor(BACKUP_QUEUE)
export class RunBackupJobProcessor {
  private readonly logger = new Logger(RunBackupJobProcessor.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly encryption: EncryptionService,
    private readonly jobsService: BackupJobsService,
    private readonly policiesService: BackupPoliciesService,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly policyRepo: BackupPolicyRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly veleroClient: VeleroClientService,
    private readonly installer: VeleroInstallerService,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
  ) {}

  @Process(BACKUP_JOB_TYPES.RUN_BACKUP)
  async handleRunBackup(job: Job<RunBackupJobData>): Promise<void> {
    const { backupJobId, operationId } = job.data;
    this.logger.log(`[run-backup] Starting backupJob=${backupJobId}`);

    const setStep = async (step: OperationStep, progress: number) => {
      await this.opRepo.update(operationId, {
        currentStep: step,
        progress,
        status: OperationStatus.IN_PROGRESS,
        startedAt: progress <= 10 ? new Date() : undefined,
      });
    };

    try {
      const backupJob = await this.jobsService.findById(backupJobId);
      const policy = backupJob.policyId
        ? await this.policiesService.findById(backupJob.policyId)
        : null;
      const cluster = await this.clusterRepo.findOne({
        where: { id: backupJob.clusterId },
      });
      if (!cluster) throw new Error(`Cluster ${backupJob.clusterId} not found`);

      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

      await setStep(OperationStep.BACKUP_RUN_RESOLVE_SCOPE, 5);

      const namespaces = this.resolvePolicyNamespaces(policy);

      // Determine BSL (primary destination)
      const primaryDest = policy
        ? this.policiesService.primaryDestinationOf(policy)
        : null;
      const primaryDestEntity = primaryDest
        ? await this.destRepo.findById(primaryDest.destinationId)
        : null;
      if (!primaryDestEntity) {
        throw new Error('No primary destination found for backup policy');
      }
      const bslName = this.installer.bslName(primaryDestEntity.id);
      const veleroBackupName = `flui-${backupJobId.slice(0, 8)}-${Date.now()}`;

      await this.jobsService.update(backupJobId, {
        veleroBackupName,
        status: BackupJobStatus.RUNNING,
        startedAt: new Date(),
      });

      await this.ensureVeleroReady(kubeconfig, primaryDestEntity, policy);

      await setStep(OperationStep.BACKUP_RUN_CREATE_VELERO_CR, 20);
      const ttlHours = (policy?.retentionDays ?? 30) * 24;
      await this.veleroClient.createBackup(kubeconfig, {
        backupName: veleroBackupName,
        policyId: policy?.id,
        jobId: backupJobId,
        bslName,
        ttlHours,
        includedNamespaces: namespaces.length === 0 ? ['*'] : namespaces,
        includePvcs: policy?.includePvcs ?? true,
      });

      await setStep(OperationStep.BACKUP_RUN_WATCH_PROGRESS, 40);
      const finalCr = await this.veleroClient.waitForBackup(
        kubeconfig,
        veleroBackupName,
      );
      const phase = finalCr?.status?.phase;
      await this.assertBackupUsable(kubeconfig, veleroBackupName, finalCr);

      await setStep(OperationStep.BACKUP_RUN_RECORD_ARTIFACT, 60);
      const artifact = this.artifactRepo.createArtifact({
        backupJobId,
        clusterId: backupJob.clusterId,
        veleroBackupName,
        sizeBytes: finalCr?.status?.progress?.totalBytes
          ? String(finalCr.status.progress.totalBytes)
          : undefined,
        itemCount: finalCr?.status?.progress?.totalItems,
        manifestSummary: {
          namespaces,
          phase,
          startTimestamp: finalCr?.status?.startTimestamp,
          completionTimestamp: finalCr?.status?.completionTimestamp,
        },
      });
      const savedArtifact = await this.artifactRepo.saveArtifact(artifact);

      const primaryLoc: Partial<BackupArtifactLocationEntity> = {
        artifactId: savedArtifact.id,
        destinationId: primaryDestEntity.id,
        role: DestinationRole.PRIMARY,
        state: ArtifactLocationState.AVAILABLE,
        // Relative to the destination's own pathPrefix, which Velero's BSL is
        // configured with directly (toVeleroBSL's `prefix`) and which
        // GenericS3Backend.getUsage()/listObjects() re-prepend via joinPrefix —
        // baking pathPrefix in here too would double it.
        objectKeyPrefix: `backups/${veleroBackupName}/`,
      };
      await this.artifactRepo.saveLocation(
        primaryLoc as BackupArtifactLocationEntity,
      );

      // Replicate to secondaries
      const replicas = policy
        ? this.policiesService.replicaDestinationsOf(policy)
        : [];

      await setStep(OperationStep.BACKUP_RUN_ENQUEUE_REPLICATION, 80);
      await this.enqueueReplicas(
        replicas,
        savedArtifact.id,
        primaryDestEntity.id,
        veleroBackupName,
      );

      const finalStatus =
        replicas.length > 0
          ? BackupJobStatus.REPLICATING
          : BackupJobStatus.COMPLETED;
      await this.jobsService.update(backupJobId, {
        status: finalStatus,
        finishedAt: replicas.length > 0 ? undefined : new Date(),
      });

      await setStep(OperationStep.BACKUP_RUN_FINALIZE, 100);
      await this.opRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        completedAt: new Date(),
        progress: 100,
      });

      this.logger.log(
        `[run-backup] Completed backupJob=${backupJobId} (${replicas.length} replicas enqueued)`,
      );
    } catch (err: any) {
      this.logger.error(`[run-backup] Failed: ${err?.message}`);
      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        finishedAt: new Date(),
      });
      await this.opRepo.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        completedAt: new Date(),
      });
      throw err;
    }
  }

  private async enqueueReplicas(
    replicas: Array<{ destinationId: string }>,
    artifactId: string,
    sourceDestinationId: string,
    veleroBackupName: string,
  ): Promise<void> {
    for (const r of replicas) {
      const replicaLoc: Partial<BackupArtifactLocationEntity> = {
        artifactId,
        destinationId: r.destinationId,
        role: DestinationRole.REPLICA,
        state: ArtifactLocationState.PENDING,
        objectKeyPrefix: `backups/${veleroBackupName}/`,
      };
      const savedLoc = await this.artifactRepo.saveLocation(
        replicaLoc as BackupArtifactLocationEntity,
      );
      await this.queue.add(BACKUP_JOB_TYPES.REPLICATE_BACKUP, {
        artifactId,
        locationId: savedLoc.id,
        sourceDestinationId,
        targetDestinationId: r.destinationId,
        veleroBackupName,
      });
    }
  }

  private resolvePolicyNamespaces(
    policy: {
      scope: BackupScope;
      scopeSelector?: { namespaces?: string[] };
    } | null,
  ): string[] {
    if (!policy) return [];
    if (policy.scope === BackupScope.CLUSTER_ALL) return [];
    if (
      policy.scope === BackupScope.NAMESPACES &&
      policy.scopeSelector?.namespaces
    ) {
      return policy.scopeSelector.namespaces;
    }
    return [];
  }

  private async ensureVeleroReady(
    kubeconfig: string,
    primaryDest: BackupDestinationEntity,
    policy: BackupPolicyEntity | null,
  ): Promise<void> {
    if (await this.installer.isInstalled(kubeconfig)) {
      await this.installer.applyBSL(kubeconfig, primaryDest, true);
      // Re-apply the node-agent so installs predating the NODE_NAME fix
      // self-heal before we wait for readiness.
      await this.installer.applyNodeAgent(kubeconfig);
      await this.installer.waitForNodeAgentReady(kubeconfig);
      return;
    }
    const replicaDestEntities = policy
      ? (
          await Promise.all(
            this.policiesService
              .replicaDestinationsOf(policy)
              .map((d) => this.destRepo.findById(d.destinationId)),
          )
        ).filter((d): d is BackupDestinationEntity => !!d)
      : [];
    await this.installer.ensureInstalled({
      kubeconfig,
      destinations: [primaryDest, ...replicaDestEntities],
      primaryDestinationId: primaryDest.id,
    });
  }

  private async assertBackupUsable(
    kubeconfig: string,
    veleroBackupName: string,
    finalCr: { status?: { phase?: string; validationErrors?: string[] } },
  ): Promise<void> {
    const phase = finalCr?.status?.phase;
    if (phase === 'Failed' || phase === 'FailedValidation') {
      const errs = finalCr?.status?.validationErrors ?? [];
      const detail = errs.length ? `: ${errs.join('; ')}` : '';
      throw new Error(`Velero backup ended with phase=${phase}${detail}`);
    }
    if (phase === 'PartiallyFailed') {
      // A PartiallyFailed backup may have captured manifests but not the volume
      // data. Never record it as a usable (AVAILABLE) restore source when any
      // PodVolumeBackup failed — that is silent data loss.
      const failedVolumes = await this.veleroClient.listFailedPodVolumeBackups(
        kubeconfig,
        veleroBackupName,
      );
      if (failedVolumes.length > 0) {
        throw new Error(
          `Velero backup ${veleroBackupName} PartiallyFailed with ${failedVolumes.length} failed volume backup(s): ${failedVolumes.join(', ')}. Not recording as a restore source.`,
        );
      }
      this.logger.warn(
        `[run-backup] ${veleroBackupName} PartiallyFailed but all volume backups completed; recording as available.`,
      );
      return;
    }
    if (phase !== 'Completed') {
      throw new Error(`Velero backup ended with unexpected phase=${phase}`);
    }
  }

  @Process(BACKUP_JOB_TYPES.PRE_DEPLOY_SNAPSHOT)
  async handlePreDeploy(
    job: Job<{ backupJobId: string; operationId: string }>,
  ): Promise<void> {
    const { backupJobId, operationId } = job.data;
    this.logger.log(`[pre-deploy] Starting backupJob=${backupJobId}`);
    try {
      const backupJob = await this.jobsService.findById(backupJobId);
      const cluster = await this.clusterRepo.findOne({
        where: { id: backupJob.clusterId },
      });
      if (!cluster) throw new Error(`Cluster ${backupJob.clusterId} not found`);
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

      await this.opRepo.update(operationId, {
        currentStep: OperationStep.PREDEPLOY_SNAPSHOT_RUN,
        status: OperationStatus.IN_PROGRESS,
        startedAt: new Date(),
        progress: 30,
      });

      // Find any active BackupPolicy on this cluster
      const policies = await this.policyRepo.findByCluster(cluster.id);
      const activePolicy = policies.find(
        (p) => p.status === BackupPolicyStatus.ACTIVE,
      );
      if (!activePolicy) {
        throw new Error(
          `No active BackupPolicy on cluster ${cluster.id} — pre-deploy snapshot skipped`,
        );
      }
      const primaryDest =
        this.policiesService.primaryDestinationOf(activePolicy);
      const destEntity = await this.destRepo.findById(
        primaryDest.destinationId,
      );
      if (!destEntity) throw new Error('Primary destination missing');

      const bslName = this.installer.bslName(destEntity.id);
      const veleroBackupName = `flui-predeploy-${backupJobId.slice(0, 8)}-${Date.now()}`;
      const ctx = backupJob.triggerContext as Record<string, string>;

      await this.veleroClient.createBackup(kubeconfig, {
        backupName: veleroBackupName,
        policyId: activePolicy.id,
        jobId: backupJobId,
        bslName,
        ttlHours: 24 * 7,
        includedNamespaces: [ctx.namespace],
        includePvcs: true,
        labelSelector: ctx.applicationId
          ? { 'flui.cloud/applicationId': ctx.applicationId }
          : undefined,
        extraLabels: {
          'flui.cloud/scope': 'pre-deploy',
          'flui.cloud/applicationId': ctx.applicationId ?? '',
          'flui.cloud/deployId': ctx.deployId ?? '',
        },
      });

      const finalCr = await this.veleroClient.waitForBackup(
        kubeconfig,
        veleroBackupName,
      );
      const phase = finalCr?.status?.phase;
      if (phase !== 'Completed') {
        throw new Error(`Pre-deploy snapshot failed phase=${phase}`);
      }

      await this.jobsService.update(backupJobId, {
        veleroBackupName,
        status: BackupJobStatus.COMPLETED,
        finishedAt: new Date(),
      });

      await this.opRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        currentStep: OperationStep.PREDEPLOY_SNAPSHOT_FINALIZE,
        completedAt: new Date(),
        progress: 100,
      });
      this.logger.log(`[pre-deploy] Completed backupJob=${backupJobId}`);
    } catch (err: any) {
      this.logger.error(`[pre-deploy] Failed: ${err?.message}`);
      await this.jobsService.update(backupJobId, {
        status: BackupJobStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        finishedAt: new Date(),
      });
      await this.opRepo.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        completedAt: new Date(),
      });
      throw err;
    }
  }
}

@Processor(BACKUP_QUEUE)
export class PreDeployTriggerProcessor {
  private readonly logger = new Logger(PreDeployTriggerProcessor.name);

  constructor(private readonly jobsService: BackupJobsService) {}

  @Process('pre-deploy-snapshot-trigger')
  async handle(
    job: Job<{
      applicationId: string;
      clusterId: string;
      userId: string;
      deployId: string;
      namespace: string;
    }>,
  ): Promise<void> {
    const { applicationId, clusterId, userId, deployId, namespace } = job.data;
    this.logger.log(
      `[pre-deploy-trigger] app=${applicationId} deploy=${deployId}`,
    );
    const { job: bj } = await this.jobsService.createPreDeploy({
      applicationId,
      clusterId,
      userId,
      deployId,
      namespace,
    });
    // Poll the BackupJob status until COMPLETED/FAILED.
    const startedAt = Date.now();
    const timeoutMs = 5 * 60 * 1000;
    while (Date.now() - startedAt < timeoutMs) {
      const current = await this.jobsService.findById(bj.id);
      if (current.status === 'completed') return;
      if (current.status === 'failed' || current.status === 'cancelled') {
        throw new Error(
          `pre-deploy snapshot finished with status ${current.status}`,
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('pre-deploy snapshot polling timeout');
  }
}
