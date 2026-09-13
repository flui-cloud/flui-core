import { Processor, Process, InjectQueue } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ObjectStorageProvisionerFactory } from '../../storage/factories/object-storage-provisioner.factory';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupPoliciesService } from '../services/backup-policies.service';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import {
  DestinationHealthStatus,
  EncryptionMode,
} from '../enums/destination-health.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { BackupPolicyProfile } from '../enums/backup-policy-status.enum';
import { BACKUP_QUEUE, BACKUP_JOB_TYPES } from '../backups.constants';
import { QUICK_SETUP_BULL_JOB_NAME } from '../services/quick-setup.service';
import * as crypto from 'node:crypto';

interface QuickSetupJobData {
  userId: string;
  clusterId: string;
  operationId: string;
  profile: 'single' | 'mirrored';
  primaryProvider: StorageBackendProvider;
  replicaProvider?: StorageBackendProvider;
  cronSchedule: string | null;
  retentionDays: number;
  runFirstBackup: boolean;
}

@Processor(BACKUP_QUEUE)
export class QuickSetupProcessor {
  private readonly logger = new Logger(QuickSetupProcessor.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly opRepo: Repository<InfrastructureOperationEntity>,
    @InjectRepository(BackupDestinationEntity)
    private readonly destOrmRepo: Repository<BackupDestinationEntity>,
    private readonly destRepo: BackupDestinationRepository,
    private readonly provisionerFactory: ObjectStorageProvisionerFactory,
    private readonly encryption: EncryptionService,
    private readonly policiesService: BackupPoliciesService,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
  ) {}

  @Process(QUICK_SETUP_BULL_JOB_NAME)
  async handle(job: Job<QuickSetupJobData>): Promise<void> {
    const data = job.data;
    const { operationId } = data;
    this.logger.log(
      `[quick-setup] cluster=${data.clusterId} profile=${data.profile} primary=${data.primaryProvider} replica=${data.replicaProvider ?? '-'}`,
    );

    const setStep = async (step: OperationStep, progress: number) => {
      await this.opRepo.update(operationId, {
        currentStep: step,
        progress,
        status: OperationStatus.IN_PROGRESS,
        startedAt: progress <= 5 ? new Date() : undefined,
      });
    };

    try {
      await setStep(OperationStep.QUICK_SETUP_RESOLVE_PROVISIONERS, 5);
      const primaryProvisioner = this.provisionerFactory.forProvider(
        data.primaryProvider,
      );
      if (!primaryProvisioner) {
        throw new Error(
          `No provisioner for primary provider ${data.primaryProvider}`,
        );
      }
      const primaryReady = await primaryProvisioner.isReady(data.userId);
      if (!primaryReady.ready) {
        throw new Error(
          `Primary provisioner not ready: ${primaryReady.reason ?? primaryReady.message}`,
        );
      }
      let replicaProvisioner = null;
      if (data.profile === 'mirrored' && data.replicaProvider) {
        replicaProvisioner = this.provisionerFactory.forProvider(
          data.replicaProvider,
        );
        if (!replicaProvisioner) {
          throw new Error(
            `No provisioner for replica provider ${data.replicaProvider}`,
          );
        }
        const replicaReady = await replicaProvisioner.isReady(data.userId);
        if (!replicaReady.ready) {
          throw new Error(
            `Replica provisioner not ready: ${replicaReady.reason ?? replicaReady.message}`,
          );
        }
      }

      await setStep(OperationStep.QUICK_SETUP_PROVISION_PRIMARY, 15);
      const primaryResult = await primaryProvisioner.provisionDestination({
        userId: data.userId,
        clusterId: data.clusterId,
        destinationName: 'auto-primary',
      });
      const primaryDest = await this.saveDestination(
        data.userId,
        data.primaryProvider,
        primaryResult,
        'auto-primary',
      );

      let replicaDest: BackupDestinationEntity | null = null;
      if (replicaProvisioner) {
        await setStep(OperationStep.QUICK_SETUP_PROVISION_REPLICA, 30);
        const replicaResult = await replicaProvisioner.provisionDestination({
          userId: data.userId,
          clusterId: data.clusterId,
          destinationName: 'auto-replica',
        });
        replicaDest = await this.saveDestination(
          data.userId,
          data.replicaProvider,
          replicaResult,
          'auto-replica',
        );
      }

      await setStep(OperationStep.QUICK_SETUP_CREATE_POLICY, 50);
      const policy = await this.policiesService.create(data.userId, {
        name: 'auto-daily',
        clusterId: data.clusterId,
        scope: BackupScope.CLUSTER_ALL,
        scopeSelector: {},
        includePvcs: true,
        includeEtcdL1: false,
        cronSchedule: data.cronSchedule ?? undefined,
        retentionDays: data.retentionDays,
        profile: replicaDest
          ? BackupPolicyProfile.MIRRORED
          : BackupPolicyProfile.SINGLE,
        destinations: [
          {
            destinationId: primaryDest.id,
            role: DestinationRole.PRIMARY,
            priority: 0,
          },
          ...(replicaDest
            ? [
                {
                  destinationId: replicaDest.id,
                  role: DestinationRole.REPLICA,
                  priority: 1,
                },
              ]
            : []),
        ],
      });

      await setStep(OperationStep.QUICK_SETUP_INSTALL_VELERO, 65);
      // Enqueue install velero (non-blocking; sub-operation tracks itself)
      const installOp = await this.opRepo.save(
        this.opRepo.create({
          operationType: OperationType.INSTALL_VELERO,
          status: OperationStatus.PENDING,
          resourceType: 'cluster',
          resourceId: data.clusterId,
          userId: data.userId,
          metadata: { parentOperationId: operationId, policyId: policy.id },
          totalSteps: 9,
        }),
      );
      await this.queue.add(BACKUP_JOB_TYPES.INSTALL_VELERO, {
        clusterId: data.clusterId,
        destinationIds: [
          primaryDest.id,
          ...(replicaDest ? [replicaDest.id] : []),
        ],
        primaryDestinationId: primaryDest.id,
        operationId: installOp.id,
        // The install starts it, once the storage location exists.
        ...(data.runFirstBackup
          ? { firstBackupPolicyId: policy.id, userId: data.userId }
          : {}),
      });

      if (data.runFirstBackup) {
        await setStep(OperationStep.QUICK_SETUP_RUN_FIRST_BACKUP, 85);
      }

      await setStep(OperationStep.QUICK_SETUP_FINALIZE, 100);
      await this.opRepo.update(operationId, {
        status: OperationStatus.COMPLETED,
        completedAt: new Date(),
        progress: 100,
      });
      this.logger.log(
        `[quick-setup] Completed cluster=${data.clusterId} policyId=${policy.id}`,
      );
    } catch (err: any) {
      this.logger.error(`[quick-setup] Failed: ${err?.message}`);
      await this.opRepo.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        completedAt: new Date(),
      });
      throw err;
    }
  }

  private async saveDestination(
    userId: string,
    provider: StorageBackendProvider,
    result: {
      bucket: string;
      region: string;
      endpoint: string;
      forcePathStyle: boolean;
      pathPrefix?: string;
      accessKey: string;
      secretKey: string;
      usableForEtcdL1: boolean;
      alreadyExisted: boolean;
    },
    nameHint: string,
  ): Promise<BackupDestinationEntity> {
    // Idempotent: cerca destination esistente con stesso bucket+region+provider
    const existing = await this.destOrmRepo.findOne({
      where: {
        userId,
        provider,
        bucket: result.bucket,
        region: result.region,
      },
    });
    if (existing) return existing;

    const passphrase = crypto.randomBytes(32).toString('hex');
    const dest = this.destRepo.create({
      userId,
      name: this.uniqueName(provider, nameHint),
      provider,
      endpoint: result.endpoint,
      region: result.region,
      bucket: result.bucket,
      pathPrefix: result.pathPrefix,
      accessKeyEncrypted: this.encryption.encrypt(result.accessKey),
      secretKeyEncrypted: this.encryption.encrypt(result.secretKey),
      encryptionMode: EncryptionMode.FLUI_MANAGED,
      encryptionPassphraseEncrypted: this.encryption.encrypt(passphrase),
      forcePathStyle: result.forcePathStyle,
      useSse: false,
      usableForEtcdL1: result.usableForEtcdL1,
      healthStatus: DestinationHealthStatus.HEALTHY,
      lastHealthCheckAt: new Date(),
      metadata: { autoProvisioned: true },
    });
    return this.destRepo.save(dest);
  }

  private uniqueName(provider: StorageBackendProvider, hint: string): string {
    const short = provider.split('_')[0];
    return `${short}-${hint}-${Date.now().toString(36)}`;
  }
}
