import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
import { cloudFamilyOfStorage } from '../../storage/utils/storage-cloud-family';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { QuickSetupDto, SetupOptionsResponse } from '../dto/quick-setup.dto';
import { BillingEstimatorService } from './billing-estimator.service';
import { BACKUP_QUEUE } from '../backups.constants';

const QUICK_SETUP_JOB = 'quick-setup';

/**
 * Candidate backup destinations in preference order. A candidate is only
 * eligible if it is NOT on the cluster's own cloud — a backup that dies with
 * the provider it protects against is not a backup.
 */
const BACKUP_STORAGE_PREFERENCE: readonly StorageBackendProvider[] = [
  StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
  StorageBackendProvider.OVH_OBJECT_STORAGE,
];

const NO_ELIGIBLE_STORAGE = 'NO_ELIGIBLE_STORAGE';
const SAME_PROVIDER_AS_CLUSTER = 'SAME_PROVIDER_AS_CLUSTER';

function needsConnection(reason?: string): boolean {
  return /^CONNECT_[A-Z_]+_REQUIRED$/.test(reason ?? '');
}

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

    const { storage: primaryStorage, readiness: primaryReady } =
      await this.selectPrimaryStorage(cluster.provider, userId);

    const eligible = await Promise.all(
      this.eligibleFor(cluster.provider).map(async (provider) => {
        const r = await this.checkReady(provider, userId);
        return {
          provider,
          ready: r.ready,
          needsConnection: !r.ready && needsConnection(r.reason),
          reason: r.reason,
          message: r.message,
        };
      }),
    );

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
          !primaryReady.ready && needsConnection(primaryReady.reason),
        reason: primaryReady.reason,
        message: primaryReady.message,
      },
      eligible,
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

    const { storage: primaryStorage, readiness } =
      await this.selectPrimaryStorage(
        cluster.provider,
        userId,
        dto.primaryProvider,
      );
    if (!readiness.ready) {
      throw new BadRequestException(
        readiness.message ??
          `No backup destination is available for a cluster on ${cluster.provider} (${readiness.reason}).`,
      );
    }

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

  /**
   * Picks where backups go. Candidates on the cluster's own cloud are excluded
   * outright, then the first connected one in preference order wins. When none
   * is connected the first eligible candidate is returned anyway, carrying its
   * own reason, so the UI can offer the right provider to connect.
   */
  private eligibleFor(
    clusterProvider: CloudProvider | string | null | undefined,
  ): StorageBackendProvider[] {
    const clusterFamily = (clusterProvider ?? '').toLowerCase();
    return BACKUP_STORAGE_PREFERENCE.filter(
      (p) => cloudFamilyOfStorage(p) !== clusterFamily,
    );
  }

  private async selectPrimaryStorage(
    clusterProvider: CloudProvider | string | null | undefined,
    userId: string,
    requested?: StorageBackendProvider,
  ): Promise<{
    storage: StorageBackendProvider;
    readiness: { ready: boolean; reason?: string; message?: string };
  }> {
    const clusterFamily = (clusterProvider ?? '').toLowerCase();
    const eligible = this.eligibleFor(clusterProvider);

    if (requested) {
      if (!eligible.includes(requested)) {
        return {
          storage: requested,
          readiness: {
            ready: false,
            reason: SAME_PROVIDER_AS_CLUSTER,
            message: `${requested} sits on ${clusterFamily}, the cluster's own cloud. A backup there dies with the outage it protects against.`,
          },
        };
      }
      return {
        storage: requested,
        readiness: await this.checkReady(requested, userId),
      };
    }

    if (eligible.length === 0) {
      return {
        storage: BACKUP_STORAGE_PREFERENCE[0],
        readiness: {
          ready: false,
          reason: NO_ELIGIBLE_STORAGE,
          message: `No backup destination is available off ${clusterFamily}. Connect a provider other than ${clusterFamily}.`,
        },
      };
    }

    let firstUnready: {
      storage: StorageBackendProvider;
      readiness: { ready: boolean; reason?: string; message?: string };
    } | null = null;

    for (const storage of eligible) {
      const readiness = await this.checkReady(storage, userId);
      if (readiness.ready) return { storage, readiness };
      firstUnready ??= { storage, readiness };
    }
    return firstUnready;
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
