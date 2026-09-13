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
import { VeleroInstallerService } from '../services/velero-installer.service';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupJobsService } from '../services/backup-jobs.service';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';

export interface InstallVeleroJobData {
  clusterId: string;
  destinationIds: string[];
  primaryDestinationId: string;
  operationId: string;
  /**
   * Policy whose first backup runs once this install is done. Velero fails a
   * backup outright when the storage location it names is not there yet, so
   * the very first one cannot be started alongside the install that creates
   * it.
   */
  firstBackupPolicyId?: string;
  userId?: string;
}

@Processor(BACKUP_QUEUE)
export class InstallVeleroProcessor {
  private readonly logger = new Logger(InstallVeleroProcessor.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly destRepo: BackupDestinationRepository,
    private readonly encryption: EncryptionService,
    private readonly installer: VeleroInstallerService,
    private readonly jobsService: BackupJobsService,
  ) {}

  @Process(BACKUP_JOB_TYPES.INSTALL_VELERO)
  async handle(job: Job<InstallVeleroJobData>): Promise<void> {
    const {
      clusterId,
      destinationIds,
      primaryDestinationId,
      operationId,
      firstBackupPolicyId,
      userId,
    } = job.data;
    this.logger.log(`[install-velero] Starting for cluster ${clusterId}`);

    const setStep = async (step: OperationStep, progress: number) => {
      await this.opRepo.update(operationId, {
        currentStep: step,
        progress,
        status: OperationStatus.IN_PROGRESS,
        startedAt: progress <= 10 ? new Date() : undefined,
      });
    };

    try {
      await setStep(OperationStep.VELERO_INSTALL_RENDER_MANIFESTS, 10);

      const cluster = await this.clusterRepo.findOne({
        where: { id: clusterId },
      });
      if (!cluster) throw new Error(`Cluster ${clusterId} not found`);
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

      const destinations = await Promise.all(
        destinationIds.map((id) => this.destRepo.findById(id)),
      );
      const filtered = destinations.filter(
        (d): d is NonNullable<typeof d> => !!d,
      );

      await setStep(OperationStep.VELERO_INSTALL_APPLY_NAMESPACE, 20);
      await this.installer.ensureInstalled({
        kubeconfig,
        destinations: filtered,
        primaryDestinationId,
      });

      await setStep(OperationStep.VELERO_INSTALL_FINALIZE, 100);

      const meta = { ...cluster.metadata } as Record<string, any>;
      meta.veleroInstall = {
        version: 'v1.14.1',
        uploader: 'kopia',
        installedAt: new Date().toISOString(),
      };
      await this.clusterRepo.update(clusterId, {
        metadata: meta,
      });

      await this.opRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        completedAt: new Date(),
        progress: 100,
      });
      this.logger.log(`[install-velero] Completed for cluster ${clusterId}`);

      if (firstBackupPolicyId && userId) {
        await this.jobsService.createOnDemand(userId, {
          policyId: firstBackupPolicyId,
        });
        this.logger.log(
          `[install-velero] Queued the first backup for policy ${firstBackupPolicyId}`,
        );
      }
    } catch (err: any) {
      this.logger.error(`[install-velero] Failed: ${err?.message}`);
      await this.opRepo.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        completedAt: new Date(),
      });
      throw err;
    }
  }
}
