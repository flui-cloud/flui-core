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
import {
  ClusterBounds,
  ClusterBoundsRegistry,
} from './cluster-bounds.registry';
import { ByosNodeRemovalService } from './byos-node-removal.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

export interface AddWorkerJobData {
  operationId: string;
  clusterId: string;
  count: number;
  providerFirewallIds: string[];
  /** The shape to buy. Absent means the cluster's own size, as it always was. */
  serverType?: string | null;
  /**
   * Where to buy it. Absent means the cluster's own region. Any other region
   * has to be one the cluster's private network reaches.
   */
  region?: string | null;
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
    private readonly bounds: ClusterBoundsRegistry,
  ) {}

  /**
   * The floor and ceiling actually in force: whatever owns them now, the
   * cluster's own columns otherwise. Both are counted across every node, the
   * master included — the number a person reads on the page.
   */
  private async effectiveBounds(
    cluster: ClusterEntity,
  ): Promise<ClusterBounds> {
    const owned = await this.bounds.boundsFor(cluster.id);
    return (
      owned ?? { min: cluster.minNodes ?? null, max: cluster.maxNodes ?? null }
    );
  }

  private assertNodeProvisioning(cluster: ClusterEntity): void {
    const providerEnum = cluster.provider as CloudProvider;
    const capSvc = this.capabilitiesFactory.isProviderSupported(providerEnum)
      ? this.capabilitiesFactory.getCapabilitiesService(providerEnum)
      : null;
    const supported =
      capSvc?.getStaticCapabilities().features.nodeProvisioning ?? false;
    if (!supported) {
      throw new BadRequestException(
        `Provider "${cluster.provider}" has no server-provisioning API, so Flui ` +
          'cannot add or remove a node here. Attach or detach the machine yourself, ' +
          'then register or remove it as a node.',
      );
    }
  }

  async addWorkers(
    clusterId: string,
    count: number = 1,
    serverType?: string | null,
    region?: string | null,
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
        'Cluster has no VNet attached, so no node can join it. Attach one via PATCH /clusters/:id/vnet.',
      );
    }

    const ceiling = (await this.effectiveBounds(cluster)).max;
    if (ceiling != null) {
      const fleet = cluster.nodes?.length ?? 0;
      if (fleet + count > ceiling) {
        throw new BadRequestException(
          `Adding ${count} node(s) would take this cluster past its ceiling of ${ceiling} (currently ${fleet}).`,
        );
      }
    }

    // Checked here rather than in the queue: a shape the provider does not sell
    // becomes an error four minutes deep in a job nobody is watching, and on a
    // loop it becomes that error every time it runs.
    if (serverType) await this.assertShapeSold(cluster, serverType);

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
        serverType: serverType ?? cluster.nodeSize,
        region: region ?? cluster.region,
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
      serverType: serverType ?? null,
      region: region ?? null,
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

  private async assertShapeSold(
    cluster: ClusterEntity,
    serverType: string,
  ): Promise<void> {
    const providerEnum = cluster.provider as CloudProvider;
    if (!this.capabilitiesFactory.isProviderSupported(providerEnum)) return;
    const capabilities =
      this.capabilitiesFactory.getCapabilitiesService(providerEnum);

    let sold: string[];
    try {
      sold = (await capabilities.getSupportedInstanceTypes()).map(
        (type) => type.id,
      );
    } catch {
      // An unreachable catalogue is not a verdict on the shape: refusing here
      // would turn the provider having a bad minute into a shape that does not
      // exist, and the purchase itself will say so if it really does not.
      return;
    }
    if (!sold.length || sold.includes(serverType)) return;

    throw new BadRequestException(
      `Provider "${cluster.provider}" does not sell "${serverType}".`,
    );
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

    // The floor counts every node, master included, the same way the ceiling
    // does and the same way the page reads it. Counting only workers here made
    // the same number mean two things at the two ends of the fence.
    const floor = (await this.effectiveBounds(cluster)).min;
    const fleet = cluster.nodes.length;

    if (floor != null && fleet - 1 < floor) {
      throw new BadRequestException(
        `Removing this node would take this cluster below its floor of ${floor} (currently ${fleet}).`,
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
