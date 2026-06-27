import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeType } from '../entities/cluster-node.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { getOperationSteps } from '../../operations/helpers/operation-steps.helper';
import { FirewallsService } from '../../firewalls/services/firewalls.service';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { ClusterNodeScalingService } from './cluster-node-scaling.service';
import { ByosNodeRemovalService } from './byos-node-removal.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

export interface AddWorkerJobData {
  operationId: string;
  clusterId: string;
  count: number;
  providerFirewallIds: string[];
}

export interface RemoveWorkerJobData {
  operationId: string;
  clusterId: string;
  nodeId: string;
}

const MAX_WORKERS_PER_CALL = 5;

@Injectable()
export class ClusterScalingService {
  private readonly logger = new Logger(ClusterScalingService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly firewallsService: FirewallsService,
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
    private readonly nodeScalingService: ClusterNodeScalingService,
    private readonly byosNodeRemoval: ByosNodeRemovalService,
  ) {}

  private assertNodeProvisioning(cluster: ClusterEntity): void {
    const providerEnum = cluster.provider as CloudProvider;
    const capSvc = this.capabilitiesFactory.isProviderSupported(providerEnum)
      ? this.capabilitiesFactory.getCapabilitiesService(providerEnum)
      : null;
    const supported =
      capSvc?.getStaticCapabilities().features.nodeProvisioning ?? false;
    if (!supported) {
      throw new BadRequestException(
        `Provider "${cluster.provider}" does not support node provisioning. ` +
          'Node add/remove is only available on Hetzner and Scaleway clusters.',
      );
    }
  }

  async addWorkers(
    clusterId: string,
    count: number = 1,
  ): Promise<InfrastructureOperationEntity> {
    if (count < 1 || count > MAX_WORKERS_PER_CALL) {
      throw new BadRequestException(
        `count must be between 1 and ${MAX_WORKERS_PER_CALL}`,
      );
    }

    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    this.assertNodeProvisioning(cluster);

    if (cluster.status !== ClusterStatus.READY) {
      throw new BadRequestException(
        `Cluster must be READY to add workers (current: ${cluster.status})`,
      );
    }

    const vnetId = cluster.metadata?.vnetConfig?.vnetId;
    if (!vnetId) {
      throw new BadRequestException(
        'Cluster has no VNet attached. Add a VNet via PATCH /clusters/:id/vnet ' +
          'or recreate the cluster with autoscalingEnabled=true to provision one automatically.',
      );
    }

    if (cluster.maxNodes != null) {
      const projected = (cluster.nodes?.length ?? 0) + count;
      if (projected > cluster.maxNodes) {
        throw new BadRequestException(
          `Adding ${count} worker(s) would exceed maxNodes=${cluster.maxNodes} (current: ${cluster.nodes?.length ?? 0}).`,
        );
      }
    }

    const firewall =
      await this.firewallsService.getFirewallByClusterId(clusterId);
    const providerFirewallIds = firewall ? [firewall.id] : [];

    const steps = getOperationSteps(OperationType.ADD_WORKER, {
      workerCount: count,
    });

    const operation = this.operationRepository.create({
      operationType: OperationType.ADD_WORKER,
      status: OperationStatus.PENDING,
      resourceType: 'cluster',
      resourceName: cluster.name,
      resourceId: cluster.id,
      provider: cluster.provider as any,
      totalSteps: steps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        clusterId,
        workerCount: count,
        providerFirewallIds,
        operationSteps: steps,
        estimatedDurationInSeconds: 240 * count,
      },
    });
    const saved = await this.operationRepository.save(operation);

    const jobData: AddWorkerJobData = {
      operationId: saved.id,
      clusterId,
      count,
      providerFirewallIds,
    };

    await this.infrastructureQueue.add('add-worker', jobData, {
      attempts: 1,
      timeout: 900000,
    });

    this.logger.log(
      `Queued add-worker (${count}) for cluster ${clusterId} (operation ${saved.id})`,
    );
    return saved;
  }

  async removeWorker(
    clusterId: string,
    nodeId: string,
  ): Promise<InfrastructureOperationEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const node = cluster.nodes?.find((n) => n.id === nodeId);
    if (!node) {
      throw new NotFoundException(
        `Node ${nodeId} not found in cluster ${clusterId}`,
      );
    }

    if (node.nodeType === NodeType.MASTER) {
      const remainingWorkers = cluster.nodes.filter(
        (n) => n.nodeType === NodeType.WORKER,
      ).length;
      const workerHint =
        remainingWorkers > 0
          ? ` The cluster still has ${remainingWorkers} worker node(s) — remove them first.`
          : '';
      throw new BadRequestException(
        `Cannot remove the master node "${node.serverName}".${workerHint} ` +
          'To tear down the entire cluster use DELETE /infrastructure/clusters/:id or `flui env destroy`.',
      );
    }

    const workerCount = cluster.nodes.filter(
      (n) => n.nodeType === NodeType.WORKER,
    ).length;

    if (cluster.minNodes != null && workerCount <= cluster.minNodes) {
      throw new BadRequestException(
        `Removing this worker would violate minNodes=${cluster.minNodes} (current workers: ${workerCount}).`,
      );
    }

    await this.nodeScalingService.assertNodeUnlocked(clusterId, nodeId);

    if ((cluster.provider as CloudProvider) === CloudProvider.BYOS) {
      return this.byosNodeRemoval.removeWorker(cluster, node);
    }

    this.assertNodeProvisioning(cluster);

    const steps = getOperationSteps(OperationType.REMOVE_WORKER);

    const operation = this.operationRepository.create({
      operationType: OperationType.REMOVE_WORKER,
      status: OperationStatus.PENDING,
      resourceType: 'cluster',
      resourceName: cluster.name,
      resourceId: cluster.id,
      provider: cluster.provider as any,
      totalSteps: steps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        clusterId,
        nodeId,
        nodeName: node.serverName,
        operationSteps: steps,
        estimatedDurationInSeconds: 180,
      },
    });
    const saved = await this.operationRepository.save(operation);

    const jobData: RemoveWorkerJobData = {
      operationId: saved.id,
      clusterId,
      nodeId,
    };

    await this.infrastructureQueue.add('remove-worker', jobData, {
      attempts: 1,
      timeout: 600000,
    });

    this.logger.log(
      `Queued remove-worker for node ${nodeId} (cluster ${clusterId}, operation ${saved.id})`,
    );
    return saved;
  }
}
