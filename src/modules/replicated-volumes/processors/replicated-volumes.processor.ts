import { Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  REPLICATED_VOLUMES_JOB_ENABLE,
  REPLICATED_VOLUMES_QUEUE,
} from '../replicated-volumes.constants';
import { EnableReplicatedVolumesJob } from '../services/replicated-volumes.service';
import { PiraeusInstallerService } from '../services/piraeus-installer.service';
import { ReplicatedPoolPreparer } from '../services/replicated-pool.preparer';
import { ReplicatedPoolState } from '../utils/replicated-volumes.core';

function poolProblem(node: string, state: ReplicatedPoolState): string | null {
  switch (state.kind) {
    case 'ready':
      return null;
    case 'no-headers':
      return `${node} has no kernel headers for ${state.kernel}, which the volume engine needs to load its module, and they could not be installed.`;
    case 'no-space':
      return `${node} has ${state.freeGiB} GiB free, not enough for the space asked plus a margin of 5 GiB.`;
    case 'no-alloc':
      return `${node} could not set aside the space for copies on its disk: its filesystem does not allow reserving it, or the disk filled up meanwhile.`;
    default:
      return `${node} could not be prepared: ${state.detail}`;
  }
}

/**
 * Prepares the nodes first, so a node that cannot hold copies stops the work
 * before anything is installed on the cluster; the storage class comes last,
 * so nobody can ask for a replicated volume the cluster cannot place yet.
 */
@Processor(REPLICATED_VOLUMES_QUEUE)
export class ReplicatedVolumesProcessor {
  private readonly logger = new Logger(ReplicatedVolumesProcessor.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    private readonly encryption: EncryptionService,
    private readonly preparer: ReplicatedPoolPreparer,
    private readonly installer: PiraeusInstallerService,
  ) {}

  @Process(REPLICATED_VOLUMES_JOB_ENABLE)
  async enable(job: Job<EnableReplicatedVolumesJob>): Promise<void> {
    const {
      operationId,
      clusterId,
      storageNodes,
      sizeGiB,
      voteZones = [],
      tieBreakers = [],
    } = job.data;
    await this.operations.update(operationId, {
      status: OperationStatus.IN_PROGRESS,
      startedAt: new Date(),
    });
    try {
      const cluster = await this.clusters.findOneOrFail({
        where: { id: clusterId },
      });
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

      await this.step(operationId, OperationStep.REPLICATED_PREPARE_NODES, 5);
      for (const node of storageNodes) {
        const problem = poolProblem(
          node,
          await this.preparer.prepare(kubeconfig, node, sizeGiB),
        );
        if (problem) throw new Error(problem);
      }
      for (const node of tieBreakers) {
        const problem = poolProblem(
          node,
          await this.preparer.prepareVote(kubeconfig, node),
        );
        if (problem)
          throw new Error(`${problem} It holds the tie-breaking vote.`);
      }

      await this.step(operationId, OperationStep.REPLICATED_INSTALL_ENGINE, 40);
      await this.installer.ensureOperator(kubeconfig);
      await this.installer.ensureCluster(kubeconfig, voteZones);
      await this.installer.moveControlOffCopies(kubeconfig, storageNodes);

      await this.step(operationId, OperationStep.REPLICATED_STORAGE_CLASS, 90);
      await this.installer.ensureStorageClass(kubeconfig);

      await this.operations.update(operationId, {
        status: OperationStatus.COMPLETED,
        progress: 100,
        completedAt: new Date(),
      });
      this.logger.log(
        `[replicated-volumes] ${cluster.name}: enabled on ${storageNodes.join(', ')}`,
      );
    } catch (error) {
      const message = (error as Error).message;
      await this.operations.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: message,
        completedAt: new Date(),
      });
      this.logger.error(`[replicated-volumes] ${clusterId}: ${message}`);
    }
  }

  private async step(
    operationId: string,
    step: OperationStep,
    progress: number,
  ): Promise<void> {
    await this.operations.update(operationId, { currentStep: step, progress });
  }
}
