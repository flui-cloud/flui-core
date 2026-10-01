import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { BACKUP_JOB_TYPES, BACKUP_QUEUE } from '../backups.constants';
import {
  ClusterProtectionService,
  ProtectedAppView,
} from '../services/cluster-protection.service';

interface ProtectClusterJobData {
  clusterId: string;
  operationId: string;
  runFirstBackup: boolean;
}

/** What an operation carries about each application, as it is decided. */
export function operationApp(app: ProtectedAppView): Record<string, unknown> {
  return {
    applicationId: app.applicationId,
    name: app.name,
    outcome: app.outcome,
    ...(app.reason ? { reason: app.reason } : {}),
    ...(app.engine ? { engine: app.engine } : {}),
    ...(app.policyId ? { policyId: app.policyId } : {}),
  };
}

@Processor(BACKUP_QUEUE)
export class ClusterProtectionProcessor {
  private readonly logger = new Logger(ClusterProtectionProcessor.name);

  constructor(
    private readonly protection: ClusterProtectionService,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly ops: Repository<InfrastructureOperationEntity>,
  ) {}

  @Process(BACKUP_JOB_TYPES.PROTECT_CLUSTER)
  async protectCluster(job: Job<ProtectClusterJobData>): Promise<void> {
    const { clusterId, operationId, runFirstBackup } = job.data;
    await this.ops.update(operationId, {
      status: OperationStatus.IN_PROGRESS,
      currentStep: OperationStep.QUICK_SETUP_CREATE_POLICY,
      startedAt: new Date(),
      progress: 5,
    });
    try {
      const apps: Array<Record<string, unknown>> = [];
      const result = await this.protection.reconcile(clusterId, {
        runFirstBackup,
        waitForLock: true,
        onProgress: async (done, total, app) => {
          apps.push(operationApp(app));
          await this.ops.update(operationId, {
            progress: Math.min(95, 5 + Math.round((done / total) * 90)),
            metadata: { kind: 'protect', apps } as never,
          });
        },
      });
      if (!result) {
        throw new Error(
          'The cluster is not protected any more, is gone, or another pass kept it busy for too long.',
        );
      }
      await this.ops.update(operationId, {
        status: OperationStatus.COMPLETED,
        currentStep: OperationStep.QUICK_SETUP_FINALIZE,
        progress: 100,
        completedAt: new Date(),
        metadata: {
          kind: 'protect',
          apps: result.applications.map(operationApp),
        } as never,
      });
    } catch (err: any) {
      this.logger.error(`[protect-cluster] ${clusterId}: ${err?.message}`);
      await this.ops.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: err?.message ?? String(err),
        completedAt: new Date(),
      });
    }
  }

  @Process(BACKUP_JOB_TYPES.PROTECT_NEW_APPLICATION)
  async protectNewApplication(
    job: Job<{ applicationId: string }>,
  ): Promise<void> {
    try {
      await this.protection.protectApplication(job.data.applicationId);
    } catch (err: any) {
      this.logger.warn(
        `[protect-cluster] application ${job.data.applicationId} left to the next sweep: ${err?.message}`,
      );
    }
  }
}
