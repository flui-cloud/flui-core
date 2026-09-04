import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { RestoreJobEntity } from '../entities/restore-job.entity';
import { RestoreJobRepository } from '../repositories/restore-job.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { VeleroClientService } from '../services/velero-client.service';
import { VeleroInstallerService } from '../services/velero-installer.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { RestoreJobStatus, RestorePlacement } from '../enums/restore-job.enum';
import {
  BACKUP_QUEUE,
  BACKUP_JOB_TYPES,
  APP_RESOURCE_LABEL,
} from '../backups.constants';

export interface RunRestoreJobData {
  restoreJobId: string;
  operationId: string;
}

@Processor(BACKUP_QUEUE)
export class RunRestoreJobProcessor {
  private readonly logger = new Logger(RunRestoreJobProcessor.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly encryption: EncryptionService,
    private readonly restoreRepo: RestoreJobRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly veleroClient: VeleroClientService,
    private readonly installer: VeleroInstallerService,
    private readonly k8s: KubernetesService,
  ) {}

  @Process(BACKUP_JOB_TYPES.RUN_RESTORE)
  async handle(job: Job<RunRestoreJobData>): Promise<void> {
    const { restoreJobId, operationId } = job.data;
    this.logger.log(`[run-restore] Starting restoreJob=${restoreJobId}`);

    const setStep = async (step: OperationStep, progress: number) => {
      await this.opRepo.update(operationId, {
        currentStep: step,
        progress,
        status: OperationStatus.IN_PROGRESS,
        startedAt: progress <= 10 ? new Date() : undefined,
      });
    };

    try {
      const restore = await this.restoreRepo.findById(restoreJobId);
      if (!restore) throw new Error(`RestoreJob ${restoreJobId} not found`);
      const artifact = await this.artifactRepo.findArtifact(restore.artifactId);
      if (!artifact)
        throw new Error(`Artifact ${restore.artifactId} not found`);
      const location = await this.artifactRepo.findLocation(
        restore.artifactId,
        restore.sourceDestinationId,
      );
      if (location?.state !== ArtifactLocationState.AVAILABLE) {
        throw new Error('Source location not AVAILABLE');
      }
      const sourceDest = await this.destRepo.findById(
        restore.sourceDestinationId,
      );
      if (!sourceDest) throw new Error('Source destination missing');

      const targetCluster = await this.clusterRepo.findOne({
        where: { id: restore.targetClusterId },
      });
      if (!targetCluster) throw new Error('Target cluster missing');
      const kubeconfig = this.encryption.decrypt(
        targetCluster.kubeconfigEncrypted,
      );

      await setStep(OperationStep.RESTORE_SELECT_SOURCE, 10);

      // Ensure Velero installed and BSL pointing to source destination exists on target cluster
      const installed = await this.installer.isInstalled(kubeconfig);
      if (installed) {
        await this.installer.applyBSL(kubeconfig, sourceDest, false);
      } else {
        await this.installer.ensureInstalled({
          kubeconfig,
          destinations: [sourceDest],
          primaryDestinationId: sourceDest.id,
        });
      }

      await setStep(OperationStep.RESTORE_ENSURE_BSL, 30);
      await this.restoreRepo.update(restoreJobId, {
        status: RestoreJobStatus.RESTORING,
        startedAt: new Date(),
      });

      // The BSL must be Available and Velero's backup-sync controller must have
      // discovered the backup from the bucket before the Restore CR is created;
      // otherwise Velero terminally FailedValidations it ("backup not found").
      await this.veleroClient.waitForStorageLocationAvailable(
        kubeconfig,
        this.installer.bslName(sourceDest.id),
      );
      await this.veleroClient.waitForBackupSynced(
        kubeconfig,
        artifact.veleroBackupName,
      );

      // `existing` means replace, and Velero cannot do that on its own: its
      // `update` policy patches the fields the backup carries and leaves every
      // field added since, then fails outright on immutable ones. Empty the
      // place first, then let the default "skip what exists" mean the right
      // thing — the volumes we deliberately kept.
      if (restore.placement === RestorePlacement.EXISTING) {
        await this.clearBeforeRestore(kubeconfig, restore);
      }

      const restoreName = `flui-restore-${restoreJobId.slice(0, 8)}-${Date.now()}`;
      await setStep(OperationStep.RESTORE_CREATE_VELERO_CR, 50);
      await this.veleroClient.createRestore(kubeconfig, {
        restoreName,
        restoreJobId,
        backupName: artifact.veleroBackupName,
        includedNamespaces: restore.targetSelector?.namespaces,
        namespaceMapping: restore.targetSelector?.namespaceMapping,
        labelSelector: restore.targetSelector?.applicationId
          ? { [APP_RESOURCE_LABEL]: restore.targetSelector.applicationId }
          : undefined,
      });

      await this.restoreRepo.update(restoreJobId, {
        veleroRestoreName: restoreName,
      });

      await setStep(OperationStep.RESTORE_WATCH_PROGRESS, 70);
      const finalCr = await this.veleroClient.waitForRestore(
        kubeconfig,
        restoreName,
      );
      const phase = finalCr?.status?.phase;
      if (phase !== 'Completed' && phase !== 'PartiallyFailed') {
        const errs: string[] = finalCr?.status?.validationErrors ?? [];
        const detail = errs.length ? `: ${errs.join('; ')}` : '';
        throw new Error(`Velero restore ended with phase=${phase}${detail}`);
      }

      await setStep(OperationStep.RESTORE_POSTPROCESS, 95);
      await this.restoreRepo.update(restoreJobId, {
        status:
          phase === 'Completed'
            ? RestoreJobStatus.COMPLETED
            : RestoreJobStatus.FAILED,
        finishedAt: new Date(),
      });

      await this.opRepo.update(operationId, {
        status:
          phase === 'Completed'
            ? OperationStatus.COMPLETED
            : OperationStatus.FAILED,
        completedAt: new Date(),
        progress: 100,
      });
      this.logger.log(`[run-restore] Completed restoreJob=${restoreJobId}`);
    } catch (err: any) {
      this.logger.error(`[run-restore] Failed: ${err?.message}`);
      await this.restoreRepo.update(restoreJobId, {
        status: RestoreJobStatus.FAILED,
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

  /**
   * Kinds an in-place restore removes before replaying the backup.
   *
   * PersistentVolumeClaim is deliberately absent. Velero's file-system backup
   * cannot read Flui's dedicated volumes at all, so deleting a claim here would
   * destroy data the restore has no copy of — a replace that silently becomes a
   * deletion. Claims are kept, and the restore then skips them.
   */
  private static readonly REPLACEABLE_KINDS = [
    'Deployment',
    'StatefulSet',
    'DaemonSet',
    'Service',
    'Ingress',
    'ConfigMap',
    'Secret',
    'HorizontalPodAutoscaler',
    'Job',
    'CronJob',
  ];

  /**
   * Removes what the restore is about to replace, scoped to what Flui authored.
   *
   * Only objects carrying `flui-app-id` are touched: a namespace can hold
   * resources somebody applied by hand, and a restore is not a licence to
   * delete them.
   */
  private async clearBeforeRestore(
    kubeconfig: string,
    restore: RestoreJobEntity,
  ): Promise<void> {
    const namespaces = restore.targetSelector?.namespaces ?? [];
    if (namespaces.length === 0) {
      throw new Error(
        'An in-place restore needs the namespaces it replaces (targetSelector.namespaces).',
      );
    }
    const appId = restore.targetSelector?.applicationId;
    const selector = appId
      ? `${APP_RESOURCE_LABEL}=${appId}`
      : APP_RESOURCE_LABEL;

    for (const namespace of namespaces) {
      for (const kind of RunRestoreJobProcessor.REPLACEABLE_KINDS) {
        const items = await this.k8s
          .listResourcesByLabel(kubeconfig, kind, namespace, selector)
          .catch(() => [] as any[]);
        for (const item of items) {
          const name = item?.metadata?.name as string | undefined;
          if (!name) continue;
          await this.k8s
            .deleteResource(kubeconfig, kind, name, namespace)
            .catch((err: any) =>
              this.logger.warn(
                `[run-restore] could not remove ${kind}/${name} in ${namespace}: ${err?.message}`,
              ),
            );
        }
      }
      this.logger.log(
        `[run-restore] cleared Flui-authored objects in ${namespace} (volumes kept) before replacing them`,
      );
    }
  }
}
