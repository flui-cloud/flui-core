import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import {
  ClusterStopResponseDto,
  ClusterStartResponseDto,
  ClusterPowerOperationResponseDto,
  ReconcileStatusResponseDto,
} from '../dto/cluster-power-management.dto';
import { ClusterResponseDto } from '../dto/cluster-response.dto';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { ICloudProvider } from 'src/modules/providers/interfaces/cloud-provider.interface';
import {
  InfrastructureOperationEntity,
  OperationType,
  OperationStatus,
} from '../../servers/entities/infrastructure-operations.entity';
import { StopClusterJobData, StartClusterJobData } from '../clusters.service';
import {
  getOperationSteps,
  getStepConfigFromSaved,
  calculateOperationProgressFromSaved,
} from '../../operations/helpers/operation-steps.helper';

/**
 * Service for managing cluster power state (stop/start servers)
 * and reconciling cluster status with real provider state
 */
@Injectable()
export class ClusterPowerManagementService {
  private readonly logger = new Logger(ClusterPowerManagementService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly providerFactory: ProviderFactory,
  ) {}

  /**
   * Stop all servers in a cluster (async - queued operation)
   */
  async stopClusterAsync(
    clusterId: string,
  ): Promise<ClusterPowerOperationResponseDto> {
    this.logger.log(`Initiating async stop for cluster ${clusterId}`);

    // Validate cluster exists
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    if (!cluster.nodes || cluster.nodes.length === 0) {
      throw new BadRequestException('Cluster has no nodes');
    }

    // Check provider supports power management
    await this.getProviderWithPowerManagement(cluster);

    // Create operation steps
    const nodeCount = cluster.nodes.length;
    const steps = getOperationSteps(OperationType.STOP_CLUSTER, {
      nodeCount,
    });

    // Create operation entity
    const operation = this.operationRepository.create({
      operationType: OperationType.STOP_CLUSTER,
      resourceType: 'cluster',
      resourceId: clusterId,
      status: OperationStatus.PENDING,
      progress: 0,
      currentStepIndex: 0,
      totalSteps: steps.length,
      metadata: {
        operationSteps: steps,
        clusterName: cluster.name,
        nodeCount: cluster.nodes.length,
        estimatedDurationInSeconds: 60 + nodeCount * 30, // ~30s per node
      },
    });

    await this.operationRepository.save(operation);

    // Add job to queue
    const jobData: StopClusterJobData = {
      operationId: operation.id,
      clusterId,
    };

    await this.infrastructureQueue.add('stop-cluster', jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      timeout: 600000, // 10 minutes
    });

    this.logger.log(
      `Stop cluster operation queued: ${operation.id} for cluster ${clusterId}`,
    );

    return {
      operation_id: operation.id,
      cluster_id: clusterId,
      status: 'pending',
      estimated_duration: `${Math.ceil((60 + nodeCount * 30) / 60)} minutes`,
      created_at: operation.createdAt,
    };
  }

  /**
   * Start all servers in a cluster (async - queued operation)
   */
  async startClusterAsync(
    clusterId: string,
  ): Promise<ClusterPowerOperationResponseDto> {
    this.logger.log(`Initiating async start for cluster ${clusterId}`);

    // Validate cluster exists
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    if (!cluster.nodes || cluster.nodes.length === 0) {
      throw new BadRequestException('Cluster has no nodes');
    }

    // Check provider supports power management
    await this.getProviderWithPowerManagement(cluster);

    // Create operation steps
    const nodeCount = cluster.nodes.length;
    const steps = getOperationSteps(OperationType.START_CLUSTER, {
      nodeCount,
    });

    // Create operation entity
    const operation = this.operationRepository.create({
      operationType: OperationType.START_CLUSTER,
      resourceType: 'cluster',
      resourceId: clusterId,
      status: OperationStatus.PENDING,
      progress: 0,
      currentStepIndex: 0,
      totalSteps: steps.length,
      metadata: {
        operationSteps: steps,
        clusterName: cluster.name,
        nodeCount: cluster.nodes.length,
        estimatedDurationInSeconds: 120 + nodeCount * 45, // ~45s per node + boot time
      },
    });

    await this.operationRepository.save(operation);

    // Add job to queue
    const jobData: StartClusterJobData = {
      operationId: operation.id,
      clusterId,
    };

    await this.infrastructureQueue.add('start-cluster', jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      timeout: 600000, // 10 minutes
    });

    this.logger.log(
      `Start cluster operation queued: ${operation.id} for cluster ${clusterId}`,
    );

    return {
      operation_id: operation.id,
      cluster_id: clusterId,
      status: 'pending',
      estimated_duration: `${Math.ceil((120 + nodeCount * 45) / 60)} minutes`,
      created_at: operation.createdAt,
    };
  }

  /**
   * Execute stop cluster operation (called by processor)
   * @deprecated Use stopCluster for sync operations
   */
  async stopCluster(clusterId: string): Promise<ClusterStopResponseDto> {
    this.logger.log(`Stopping cluster ${clusterId}`);

    // Get cluster with nodes
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    if (!cluster.nodes || cluster.nodes.length === 0) {
      throw new BadRequestException('Cluster has no nodes');
    }

    // Check if already stopped
    if (cluster.status === ClusterStatus.STOPPED) {
      this.logger.log(`Cluster ${clusterId} is already stopped`);
      return {
        cluster_id: cluster.id,
        cluster_name: cluster.name,
        status: ClusterStatus.STOPPED,
        servers_stopped: 0,
        total_servers: cluster.nodes.length,
        monthly_savings_estimate: this.calculateSavings(cluster.nodes.length),
      };
    }

    // Get provider
    const provider = await this.getProviderWithPowerManagement(cluster);

    // Stop all servers
    let stoppedCount = 0;
    for (const node of cluster.nodes) {
      try {
        // Check current server status
        const serverDto = await provider.getServerDetailsAsDto(
          node.providerResourceId,
        );

        if (serverDto && serverDto.status !== 'off') {
          this.logger.log(
            `Powering off server ${node.serverName} (${node.providerResourceId})`,
          );
          await provider.powerOffServer(node.providerResourceId);
          stoppedCount++;
        } else {
          this.logger.log(`Server ${node.serverName} is already off`);
        }
      } catch (error) {
        this.logger.error(
          `Failed to stop server ${node.serverName}: ${error.message}`,
        );
        throw new BadRequestException(
          `Failed to stop server ${node.serverName}: ${error.message}`,
        );
      }
    }

    // Update cluster status
    cluster.status = ClusterStatus.STOPPED;
    await this.clusterRepository.save(cluster);

    this.logger.log(
      `Successfully stopped ${stoppedCount} servers in cluster ${clusterId}`,
    );

    return {
      cluster_id: cluster.id,
      cluster_name: cluster.name,
      status: ClusterStatus.STOPPED,
      servers_stopped: stoppedCount,
      total_servers: cluster.nodes.length,
      monthly_savings_estimate: this.calculateSavings(cluster.nodes.length),
    };
  }

  /**
   * Start all servers in a cluster
   */
  async startCluster(clusterId: string): Promise<ClusterStartResponseDto> {
    this.logger.log(`Starting cluster ${clusterId}`);

    // Get cluster with nodes
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    if (!cluster.nodes || cluster.nodes.length === 0) {
      throw new BadRequestException('Cluster has no nodes');
    }

    // Check if already running
    if (cluster.status === ClusterStatus.READY) {
      this.logger.log(`Cluster ${clusterId} is already running`);
      return {
        cluster_id: cluster.id,
        cluster_name: cluster.name,
        status: ClusterStatus.READY,
        servers_started: 0,
        total_servers: cluster.nodes.length,
      };
    }

    // Get provider
    const provider = await this.getProviderWithPowerManagement(cluster);

    // Start all servers
    let startedCount = 0;
    for (const node of cluster.nodes) {
      try {
        // Check current server status
        const serverDto = await provider.getServerDetailsAsDto(
          node.providerResourceId,
        );

        if (serverDto?.status === 'off') {
          this.logger.log(
            `Powering on server ${node.serverName} (${node.providerResourceId})`,
          );
          await provider.powerOnServer(node.providerResourceId);
          startedCount++;
        } else {
          this.logger.log(`Server ${node.serverName} is already running`);
        }
      } catch (error) {
        this.logger.error(
          `Failed to start server ${node.serverName}: ${error.message}`,
        );
        throw new BadRequestException(
          `Failed to start server ${node.serverName}: ${error.message}`,
        );
      }
    }

    // Update cluster status
    cluster.status = ClusterStatus.READY;
    await this.clusterRepository.save(cluster);

    this.logger.log(
      `Successfully started ${startedCount} servers in cluster ${clusterId}`,
    );

    return {
      cluster_id: cluster.id,
      cluster_name: cluster.name,
      status: ClusterStatus.READY,
      servers_started: startedCount,
      total_servers: cluster.nodes.length,
    };
  }

  /**
   * Reconcile cluster status with real provider state
   */
  async reconcileClusterStatus(
    clusterId: string,
    autoFix: boolean = false,
  ): Promise<ReconcileStatusResponseDto> {
    this.logger.log(
      `Reconciling cluster status for ${clusterId} (autoFix: ${autoFix})`,
    );

    const cluster = await this.loadClusterWithNodes(clusterId);
    const previousStatus = cluster.status;
    const actions: string[] = [];

    const provider = this.getCloudProviderOrNull(cluster);
    if (!provider) {
      return {
        cluster_id: cluster.id,
        cluster_name: cluster.name,
        previous_status: previousStatus,
        new_status: cluster.status,
        is_synced: true,
        nodes_reconciled: cluster.nodes.length,
        actions_taken: [
          `Provider ${cluster.provider} has no power-management API; ` +
            `status reflects node readiness — nothing to reconcile`,
        ],
      };
    }

    const counts = await this.countNodeStates(cluster, provider);
    const totalNodes = cluster.nodes.length;

    const reconciled = await this.computeReconciliation(
      cluster,
      counts,
      totalNodes,
      autoFix,
      actions,
      clusterId,
    );

    if (reconciled.newStatus !== cluster.status) {
      cluster.status = reconciled.newStatus;
      await this.clusterRepository.save(cluster);
    }

    this.logger.log(
      `Reconciliation complete for cluster ${clusterId}. Actions: ${actions.length}`,
    );

    return {
      cluster_id: cluster.id,
      cluster_name: cluster.name,
      previous_status: previousStatus,
      new_status: reconciled.newStatus,
      is_synced: reconciled.isSynced,
      nodes_reconciled: totalNodes,
      actions_taken: actions,
    };
  }

  private async loadClusterWithNodes(
    clusterId: string,
  ): Promise<ClusterEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    if (!cluster.nodes || cluster.nodes.length === 0) {
      throw new BadRequestException('Cluster has no nodes');
    }
    return cluster;
  }

  private async countNodeStates(
    cluster: ClusterEntity,
    provider: {
      getServerDetailsAsDto(id: string): Promise<{ status?: string } | null>;
    },
  ): Promise<{
    runningCount: number;
    stoppedCount: number;
    otherCount: number;
  }> {
    let runningCount = 0;
    let stoppedCount = 0;
    let otherCount = 0;
    for (const node of cluster.nodes) {
      try {
        const serverDto = await provider.getServerDetailsAsDto(
          node.providerResourceId,
        );
        if (!serverDto) continue;
        if (serverDto.status === 'running') runningCount++;
        else if (serverDto.status === 'off') stoppedCount++;
        else otherCount++;
      } catch (error) {
        this.logger.warn(
          `Could not check status for node ${node.serverName}: ${error.message}`,
        );
        otherCount++;
      }
    }
    return { runningCount, stoppedCount, otherCount };
  }

  private async computeReconciliation(
    cluster: ClusterEntity,
    counts: { runningCount: number; stoppedCount: number; otherCount: number },
    totalNodes: number,
    autoFix: boolean,
    actions: string[],
    clusterId: string,
  ): Promise<{ newStatus: ClusterStatus; isSynced: boolean }> {
    const { runningCount, stoppedCount, otherCount } = counts;

    if (stoppedCount === totalNodes) {
      if (cluster.status !== ClusterStatus.STOPPED) {
        actions.push(
          `Updated cluster status from ${cluster.status} to ${ClusterStatus.STOPPED} (all servers are off)`,
        );
        return { newStatus: ClusterStatus.STOPPED, isSynced: false };
      }
      return { newStatus: cluster.status, isSynced: true };
    }

    if (runningCount === totalNodes) {
      if (cluster.status !== ClusterStatus.READY) {
        actions.push(
          `Updated cluster status from ${cluster.status} to ${ClusterStatus.READY} (all servers are running)`,
        );
        return { newStatus: ClusterStatus.READY, isSynced: false };
      }
      return { newStatus: cluster.status, isSynced: true };
    }

    this.logger.warn(
      `Cluster ${clusterId} has mixed server states: ${runningCount} running, ${stoppedCount} stopped, ${otherCount} other`,
    );
    actions.push(
      `Detected inconsistent state: ${runningCount} running, ${stoppedCount} stopped, ${otherCount} other`,
    );

    if (autoFix) {
      await this.autoFixMixedState(
        cluster,
        runningCount,
        stoppedCount,
        actions,
        clusterId,
      );
      return { newStatus: cluster.status, isSynced: true };
    }
    return { newStatus: cluster.status, isSynced: false };
  }

  private async autoFixMixedState(
    cluster: ClusterEntity,
    runningCount: number,
    stoppedCount: number,
    actions: string[],
    clusterId: string,
  ): Promise<void> {
    if (cluster.status === ClusterStatus.STOPPED) {
      this.logger.log(
        `Auto-fix: stopping ${runningCount} running servers to match STOPPED state`,
      );
      await this.stopCluster(clusterId);
      actions.push(`Auto-fixed: stopped ${runningCount} running servers`);
    } else if (cluster.status === ClusterStatus.READY) {
      this.logger.log(
        `Auto-fix: starting ${stoppedCount} stopped servers to match READY state`,
      );
      await this.startCluster(clusterId);
      actions.push(`Auto-fixed: started ${stoppedCount} stopped servers`);
    }
  }

  /**
   * Enrich cluster DTO with real-time status from provider
   */
  async enrichClusterWithRealStatus(
    cluster: ClusterEntity,
  ): Promise<ClusterResponseDto> {
    this.logger.log(
      `Enriching cluster ${cluster.id} with real-time status from provider`,
    );

    try {
      const provider = await this.getProviderWithPowerManagement(cluster);

      let runningCount = 0;
      let stoppedCount = 0;

      // Enrich each node with provider status
      const enrichedNodes = await Promise.all(
        cluster.nodes.map(async (node) => {
          try {
            const serverDto = await provider.getServerDetailsAsDto(
              node.providerResourceId,
            );

            if (serverDto) {
              const providerStatus = serverDto.status;
              const isSynced =
                (cluster.status === ClusterStatus.READY &&
                  providerStatus === 'running') ||
                (cluster.status === ClusterStatus.STOPPED &&
                  providerStatus === 'off');

              if (providerStatus === 'running') runningCount++;
              if (providerStatus === 'off') stoppedCount++;

              return {
                ...node,
                provider_status: providerStatus,
                is_synced: isSynced,
              };
            }

            return {
              ...node,
              provider_status: 'unknown',
              is_synced: false,
            };
          } catch (error) {
            this.logger.warn(
              `Failed to get status for node ${node.serverName}: ${error.message}`,
            );
            return {
              ...node,
              provider_status: 'unknown',
              is_synced: false,
            };
          }
        }),
      );

      // Determine cluster real status
      let clusterRealStatus: string;
      if (stoppedCount === cluster.nodes.length) {
        clusterRealStatus = 'all_stopped';
      } else if (runningCount === cluster.nodes.length) {
        clusterRealStatus = 'all_running';
      } else {
        clusterRealStatus = 'mixed';
      }

      const isSynced =
        (cluster.status === ClusterStatus.READY &&
          clusterRealStatus === 'all_running') ||
        (cluster.status === ClusterStatus.STOPPED &&
          clusterRealStatus === 'all_stopped');

      // Map to DTO
      return {
        id: cluster.id,
        name: cluster.name,
        provider: cluster.provider,
        region: cluster.region,
        nodeSize: cluster.nodeSize,
        nodeCount: cluster.nodeCount,
        status: cluster.status,
        clusterType: cluster.clusterType,
        autoscalingEnabled: cluster.autoscalingEnabled,
        minNodes: cluster.minNodes,
        maxNodes: cluster.maxNodes,
        k3sVersion: cluster.k3sVersion,
        masterIpAddress: cluster.masterIpAddress,
        nodes: enrichedNodes as any,
        cluster_real_status: clusterRealStatus,
        is_synced: isSynced,
        createdAt: cluster.createdAt,
        updatedAt: cluster.updatedAt,
      };
    } catch (error) {
      this.logger.error(
        `Failed to enrich cluster with real status: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Execute stop cluster operation - called by queue processor
   */
  async executeStopCluster(
    clusterId: string,
    operationId: string,
  ): Promise<void> {
    this.logger.log(
      `Executing stop cluster for ${clusterId} (operation: ${operationId})`,
    );

    try {
      // Step 0: CLUSTER_STOP_INIT (5%)
      await this.updateOperationStep(operationId, 0, 0, {
        status: OperationStatus.IN_PROGRESS,
      });

      // Get cluster with nodes
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
        relations: ['nodes'],
      });

      if (!cluster) {
        throw new NotFoundException(`Cluster ${clusterId} not found`);
      }

      // Get provider
      const provider = await this.getProviderWithPowerManagement(cluster);

      await this.updateOperationStep(operationId, 0, 100, {
        message: 'Initialization complete',
      });

      // Step 1: CLUSTER_STOP_SERVERS (85%)
      await this.updateOperationStep(operationId, 1, 0, {
        message: 'Stopping cluster servers',
      });

      let stoppedCount = 0;
      const totalNodes = cluster.nodes.length;

      for (let i = 0; i < cluster.nodes.length; i++) {
        const node = cluster.nodes[i];

        this.logger.log(
          `Stopping server ${i + 1}/${totalNodes}: ${node.serverName}`,
        );

        try {
          // Validate providerResourceId
          if (
            !node.providerResourceId ||
            Number.isNaN(Number(node.providerResourceId))
          ) {
            throw new Error(
              `Node ${node.serverName} has invalid providerResourceId: ${node.providerResourceId}`,
            );
          }

          // Check current server status
          const serverDto = await provider.getServerDetailsAsDto(
            node.providerResourceId,
          );

          if (!serverDto) {
            throw new Error(
              `Failed to get server details for ${node.serverName} (${node.providerResourceId})`,
            );
          }

          if (serverDto.status === 'off') {
            this.logger.log(`Server ${node.serverName} is already off`);
          } else {
            this.logger.log(
              `Powering off server ${node.serverName} (${node.providerResourceId})`,
            );
            await provider.powerOffServer(node.providerResourceId);
            stoppedCount++;
          }

          // Update progress within step
          const stepProgress = Math.floor(((i + 1) / totalNodes) * 100);
          await this.updateOperationStep(operationId, 1, stepProgress, {
            currentNode: `${i + 1}/${totalNodes}`,
            currentNodeName: node.serverName,
            serversStopped: stoppedCount,
          });
        } catch (error) {
          this.logger.error(
            `Failed to stop server ${node.serverName}: ${error.message}`,
          );
          throw error;
        }
      }

      // Step 2: CLUSTER_STOP_UPDATE_STATUS (10%)
      await this.updateOperationStep(operationId, 2, 0, {
        message: 'Updating cluster status',
      });

      // Update cluster status
      cluster.status = ClusterStatus.STOPPED;
      await this.clusterRepository.save(cluster);

      await this.updateOperationStep(operationId, 2, 100, {
        status: OperationStatus.COMPLETED,
        message: `Cluster stopped successfully. ${stoppedCount}/${totalNodes} servers stopped`,
        serversStopped: stoppedCount,
        totalServers: totalNodes,
        monthlySavingsEstimate: this.calculateSavings(totalNodes),
      });

      this.logger.log(
        `Successfully stopped ${stoppedCount} servers in cluster ${clusterId}`,
      );
    } catch (error) {
      this.logger.error(
        `Error executing stop cluster: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Execute start cluster operation - called by queue processor
   */
  async executeStartCluster(
    clusterId: string,
    operationId: string,
  ): Promise<void> {
    this.logger.log(
      `Executing start cluster for ${clusterId} (operation: ${operationId})`,
    );

    try {
      // Step 0: CLUSTER_START_INIT (5%)
      await this.updateOperationStep(operationId, 0, 0, {
        status: OperationStatus.IN_PROGRESS,
      });

      // Get cluster with nodes
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
        relations: ['nodes'],
      });

      if (!cluster) {
        throw new NotFoundException(`Cluster ${clusterId} not found`);
      }

      // Get provider
      const provider = await this.getProviderWithPowerManagement(cluster);

      await this.updateOperationStep(operationId, 0, 100, {
        message: 'Initialization complete',
      });

      // Step 1: CLUSTER_START_SERVERS (70%)
      await this.updateOperationStep(operationId, 1, 0, {
        message: 'Starting cluster servers',
      });

      let startedCount = 0;
      const totalNodes = cluster.nodes.length;

      for (let i = 0; i < cluster.nodes.length; i++) {
        const node = cluster.nodes[i];

        this.logger.log(
          `Starting server ${i + 1}/${totalNodes}: ${node.serverName}`,
        );

        try {
          // Validate providerResourceId
          if (
            !node.providerResourceId ||
            Number.isNaN(Number(node.providerResourceId))
          ) {
            throw new Error(
              `Node ${node.serverName} has invalid providerResourceId: ${node.providerResourceId}`,
            );
          }

          // Check current server status
          const serverDto = await provider.getServerDetailsAsDto(
            node.providerResourceId,
          );

          if (!serverDto) {
            throw new Error(
              `Failed to get server details for ${node.serverName} (${node.providerResourceId})`,
            );
          }

          if (serverDto.status === 'off') {
            this.logger.log(
              `Powering on server ${node.serverName} (${node.providerResourceId})`,
            );
            await provider.powerOnServer(node.providerResourceId);
            startedCount++;
          } else {
            this.logger.log(`Server ${node.serverName} is already running`);
          }

          // Update progress within step
          const stepProgress = Math.floor(((i + 1) / totalNodes) * 100);
          await this.updateOperationStep(operationId, 1, stepProgress, {
            currentNode: `${i + 1}/${totalNodes}`,
            currentNodeName: node.serverName,
            serversStarted: startedCount,
          });
        } catch (error) {
          this.logger.error(
            `Failed to start server ${node.serverName}: ${error.message}`,
          );
          throw error;
        }
      }

      // Step 2: CLUSTER_START_WAIT_READY (15%)
      await this.updateOperationStep(operationId, 2, 0, {
        message: 'Waiting for servers to become ready',
      });

      await this.updateOperationStep(operationId, 2, 100, {
        message: 'Servers are starting up',
      });

      // Step 3: CLUSTER_START_UPDATE_STATUS (10%)
      await this.updateOperationStep(operationId, 3, 0, {
        message: 'Updating cluster status',
      });

      // Update cluster status
      cluster.status = ClusterStatus.READY;
      await this.clusterRepository.save(cluster);

      await this.updateOperationStep(operationId, 3, 100, {
        status: OperationStatus.COMPLETED,
        message: `Cluster started successfully. ${startedCount}/${totalNodes} servers started`,
        serversStarted: startedCount,
        totalServers: totalNodes,
      });

      this.logger.log(
        `Successfully started ${startedCount} servers in cluster ${clusterId}`,
      );
    } catch (error) {
      this.logger.error(
        `Error executing start cluster: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Update operation step helper
   */
  private async updateOperationStep(
    operationId: string,
    stepIndex: number,
    stepProgress: number,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });

    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    // Get saved steps from metadata
    const savedSteps = operation.metadata?.operationSteps || [];

    const stepConfig = getStepConfigFromSaved(savedSteps, stepIndex);
    if (!stepConfig) {
      throw new Error(
        `Invalid step index ${stepIndex} for operation ${operationId}`,
      );
    }

    const overallProgress = calculateOperationProgressFromSaved(
      savedSteps,
      stepIndex,
      stepProgress,
    );

    operation.currentStep = stepConfig.step;
    operation.currentStepIndex = stepIndex;
    operation.totalSteps = savedSteps.length;
    operation.currentStepProgress = stepProgress;
    operation.progress = overallProgress;

    // Update status if provided in metadata
    if (metadata.status) {
      operation.status = metadata.status;
      if (
        metadata.status === OperationStatus.IN_PROGRESS &&
        !operation.startedAt
      ) {
        operation.startedAt = new Date();
      }
      if (metadata.status === OperationStatus.COMPLETED) {
        operation.completedAt = new Date();
      }
    }

    operation.metadata = {
      ...operation.metadata,
      ...metadata,
      stepDescription: stepConfig.description,
      stepWeight: stepConfig.weight,
    };

    await this.operationRepository.save(operation);
  }

  /**
   * Get provider and verify it supports power management
   */
  private getCloudProviderOrNull(
    cluster: ClusterEntity,
  ): ICloudProvider | null {
    const supported = this.providerFactory.getSupportedProviders() as string[];
    if (!supported.includes(cluster.provider)) return null;
    const provider = this.providerFactory.getProvider(cluster.provider as any);
    if (!provider.powerOnServer || !provider.powerOffServer) return null;
    return provider;
  }

  private async getProviderWithPowerManagement(
    cluster: ClusterEntity,
  ): Promise<ICloudProvider> {
    const provider = this.getCloudProviderOrNull(cluster);
    if (!provider) {
      throw new BadRequestException(
        `Provider ${cluster.provider} does not support power management operations`,
      );
    }
    return provider;
  }

  /**
   * Calculate monthly savings when cluster is stopped
   */
  private calculateSavings(nodeCount: number): string {
    const savingsPerNode = 6.9; // ~7.50€ running - ~0.60€ storage = ~6.90€ savings
    const totalSavings = savingsPerNode * nodeCount;
    return `~${totalSavings.toFixed(2)}€`;
  }
}
