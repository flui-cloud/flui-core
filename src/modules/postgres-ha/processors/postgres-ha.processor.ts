import { Logger } from '@nestjs/common';
import { singleInstanceSelector } from '../utils/postgres-ha-migration.core';
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { DbPodExecService } from '../../db-lifecycle/services/db-pod-exec.service';
import { FluiStorageClass } from '../../infrastructure/clusters/constants/storage-conventions';
import {
  CLUSTER_POD_NETWORK,
  POSTGRES_HA_JOB_ACTIVATE,
  POSTGRES_HA_QUEUE,
} from '../postgres-ha.constants';
import {
  ActivateDatabaseHaJob,
  HA_INSTANCES,
} from '../services/postgres-ha.service';
import { PostgresHaPortsAdapter } from '../services/postgres-ha-ports.adapter';
import {
  HaActivationError,
  PostgresHaActivationRunner,
} from '../services/postgres-ha-activation.runner';
import { ModuleRef } from '@nestjs/core';
import { DatabaseHaBackupHandoverService } from '../../backups/services/database-ha-backup-handover.service';

const DEFAULT_SIZE_GI = 10;

function sizeGiOf(app: ApplicationEntity): number {
  const size = app.volumes?.[0]?.size ?? '';
  const match = /^(\d+)(Gi|G)$/.exec(size);
  return match ? Number(match[1]) : DEFAULT_SIZE_GI;
}

@Processor(POSTGRES_HA_QUEUE)
export class PostgresHaProcessor {
  private readonly logger = new Logger(PostgresHaProcessor.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    private readonly encryption: EncryptionService,
    private readonly exec: DbPodExecService,
    private readonly adapter: PostgresHaPortsAdapter,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * The database's continuous backup follows it to the cluster that now
   * serves. Looked up at run time: backups depend on databases, not the
   * other way round. A failure leaves the database highly available and says
   * that its backup did not follow, which is the one thing to act on.
   */
  private async handBackupOver(appId: string): Promise<string | null> {
    try {
      const handover = this.moduleRef.get(DatabaseHaBackupHandoverService, {
        strict: false,
      });
      return await handover.handOver(appId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[postgres-ha] ${appId}: backup not handed over: ${message}`,
      );
      return `The database is highly available, but its continuous backup did not move to the new cluster: ${message}. Until it does, no new backup is taken.`;
    }
  }

  @Process(POSTGRES_HA_JOB_ACTIVATE)
  async activate(job: Job<ActivateDatabaseHaJob>): Promise<void> {
    const { operationId, appId, durability, preferredZones } = job.data;
    await this.operations.update(operationId, {
      status: OperationStatus.IN_PROGRESS,
      startedAt: new Date(),
    });
    try {
      const app = await this.apps.findOneOrFail({ where: { id: appId } });
      const cluster = await this.clusters.findOneOrFail({
        where: { id: app.clusterId },
      });
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
      const resolved = await this.exec.resolve(appId);
      const source = {
        ...resolved,
        labelSelector: singleInstanceSelector(resolved.labelSelector),
      };
      const runner = new PostgresHaActivationRunner(
        this.adapter.portsFor({ app, kubeconfig, source, operationId }),
      );
      const spec = await runner.run({
        appId,
        slug: app.slug,
        namespace: app.k8sNamespace,
        durability,
        instances: HA_INSTANCES,
        preferredZones,
        storageClass: FluiStorageClass.LOCAL,
        sizeGi: sizeGiOf(app),
        podNetwork: CLUSTER_POD_NETWORK,
        replicationPassword: randomBytes(24).toString('hex'),
      });
      const backup = await this.handBackupOver(appId);
      await this.operations.update(operationId, {
        status: OperationStatus.COMPLETED,
        progress: 100,
        completedAt: new Date(),
        ...(backup && { errorMessage: backup }),
      });
      this.logger.log(`[postgres-ha] ${app.slug}: served by ${spec.cluster}`);
    } catch (error) {
      const message = (error as Error).message;
      const sourceServes =
        error instanceof HaActivationError ? error.sourceServes : true;
      await this.operations.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: sourceServes
          ? message
          : `${message} The database is held read-only; nothing reverts on its own.`,
        completedAt: new Date(),
      });
      this.logger.error(`[postgres-ha] ${appId}: ${message}`);
    }
  }
}
