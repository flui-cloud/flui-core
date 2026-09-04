import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ObjectStorageProvisionerFactory } from '../../storage/factories/object-storage-provisioner.factory';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { QuickSetupDto, SetupOptionsResponse } from '../dto/quick-setup.dto';
import { BillingEstimatorService } from './billing-estimator.service';
import { BACKUP_QUEUE } from '../backups.constants';

const QUICK_SETUP_JOB = 'quick-setup';

// MVP: backups are always written to Scaleway Object Storage, regardless of
// the cluster's compute provider. Hetzner Object Storage as a backup
// destination will be revisited post-MVP.
const MVP_BACKUP_STORAGE = StorageBackendProvider.SCALEWAY_OBJECT_STORAGE;

@Injectable()
export class QuickSetupService {
  private readonly logger = new Logger(QuickSetupService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    private readonly provisionerFactory: ObjectStorageProvisionerFactory,
    private readonly billing: BillingEstimatorService,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
  ) {}

  async getSetupOptions(
    userId: string,
    clusterId: string,
  ): Promise<SetupOptionsResponse> {
    const cluster = await this.clusterRepo.findOne({
      where: { id: clusterId },
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);

    const primaryStorage = MVP_BACKUP_STORAGE;
    const primaryReady = await this.checkReady(primaryStorage, userId);

    const [clusterEst, singleEst] = await Promise.all([
      this.billing.estimateClusterMonthlyCost(clusterId),
      this.billing.estimateBackupMonthlyCost(
        clusterId,
        'single',
        primaryStorage,
      ),
    ]);

    return {
      currentProvider: cluster.provider,
      primary: {
        provider: primaryStorage,
        ready: primaryReady.ready,
        needsConnection:
          !primaryReady.ready &&
          primaryReady.reason === 'CONNECT_SCALEWAY_REQUIRED',
        reason: primaryReady.reason,
        message: primaryReady.message,
      },
      recommendedReplicas: [],
      estimate: {
        currency: 'EUR',
        clusterMonthlyCents: clusterEst.clusterMonthlyCents,
        clusterUnavailableReason: clusterEst.unavailableReason,
        backupMonthlyCentsBy: {
          single: singleEst.totalCentsPerMonth,
          mirrored: null,
        },
        backupUnavailableReason: singleEst.unavailableReason,
        estimatedDataGb: singleEst.estimatedDataGb,
        estimatedDataSource: singleEst.estimatedDataSource,
        backupScope: {
          k8sResources: true,
          // Not the whole truth and it must not read like it: Velero's
          // file-system backup cannot read hostPath volumes, which is every
          // volume on the dedicated storage class — the class databases use.
          persistentVolumes: 'shared-storage-only',
          method: 'velero+kopia',
          notes:
            'Velero snapshots Kubernetes resources (manifests, ConfigMaps, Secrets, Deployments) and Kopia file-system-backs up volumes on the shared storage class. Volumes on the dedicated class — which is what databases use — are NOT captured: protect those with a database-class policy (Postgres) or a volume copy. Image registries and state outside the cluster are not included.',
        },
        disclaimer: singleEst.disclaimer,
      },
    };
  }

  async startQuickSetup(
    userId: string,
    clusterId: string,
    dto: QuickSetupDto,
  ): Promise<{ operationId: string }> {
    const cluster = await this.clusterRepo.findOne({
      where: { id: clusterId },
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);

    const primaryStorage = MVP_BACKUP_STORAGE;

    const op = await this.opRepo.save(
      this.opRepo.create({
        operationType: OperationType.BACKUP_QUICK_SETUP,
        status: OperationStatus.PENDING,
        resourceType: 'cluster',
        resourceId: clusterId,
        userId,
        metadata: { dto, primaryStorage },
        totalSteps: 7,
      }),
    );

    await this.queue.add(QUICK_SETUP_JOB, {
      userId,
      clusterId,
      operationId: op.id,
      profile: dto.profile,
      primaryProvider: primaryStorage,
      replicaProvider: undefined,
      cronSchedule:
        dto.cronSchedule === null ? null : (dto.cronSchedule ?? '0 2 * * *'),
      retentionDays: dto.retentionDays ?? 30,
      runFirstBackup: dto.runFirstBackup ?? true,
    });
    return { operationId: op.id };
  }

  private async checkReady(
    storage: StorageBackendProvider,
    userId: string,
  ): Promise<{ ready: boolean; reason?: string; message?: string }> {
    const provisioner = this.provisionerFactory.forProvider(storage);
    if (!provisioner) {
      return { ready: false, reason: 'NO_PROVISIONER_REGISTERED' };
    }
    return provisioner.isReady(userId);
  }
}

export const QUICK_SETUP_BULL_JOB_NAME = QUICK_SETUP_JOB;
