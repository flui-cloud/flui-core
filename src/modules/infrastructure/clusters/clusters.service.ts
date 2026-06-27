import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { KubernetesService } from '../shared/services/kubernetes.service';
import {
  ResourceAvailabilityResponseDto,
  ResourceAvailabilityReason,
} from './dto/resource-availability.dto';
import {
  BuildResourcesResponseDto,
  BuildResourceStatus,
} from './dto/build-resources.dto';
import {
  BUILD_JOB_CPU_REQUEST,
  BUILD_JOB_MEMORY_REQUEST,
} from '../../app-builds/services/build-job.service';
import { ClusterEntity, ClusterStatus } from './entities/cluster.entity';
import { ClusterNodeEntity } from './entities/cluster-node.entity';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { CreateClusterDto } from './dto/create-cluster.dto';
import { ClusterResponseDto } from './dto/cluster-response.dto';
import {
  RegisterClusterDto,
  RegisterClusterResponseDto,
} from './dto/register-cluster.dto';

// Import new modular services
import { ClusterValidationService } from './services/cluster-validation.service';
import { ClusterCreationService } from './services/cluster-creation.service';
import { ClusterDeletionService } from './services/cluster-deletion.service';
import { ClusterMapperService } from './services/cluster-mapper.service';
import { ClusterOperationsService } from './services/cluster-operations.service';
import { ClusterPowerManagementService } from './services/cluster-power-management.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  ReconcileStatusResponseDto,
  ClusterPowerOperationResponseDto,
} from './dto/cluster-power-management.dto';

export interface CreateClusterJobData {
  operationId: string;
  clusterId: string;
}

export interface DeleteClusterJobData {
  operationId: string;
  clusterId: string;
  force: boolean;
}

export interface StopClusterJobData {
  operationId: string;
  clusterId: string;
}

export interface StartClusterJobData {
  operationId: string;
  clusterId: string;
}

/**
 * Main orchestrator service for cluster operations
 * Delegates to specialized services for better separation of concerns
 */
@Injectable()
export class ClustersService {
  private readonly logger = new Logger(ClustersService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly clusterValidationService: ClusterValidationService,
    private readonly clusterCreationService: ClusterCreationService,
    private readonly clusterDeletionService: ClusterDeletionService,
    private readonly clusterMapperService: ClusterMapperService,
    private readonly clusterOperationsService: ClusterOperationsService,
    private readonly clusterPowerManagementService: ClusterPowerManagementService,
    private readonly encryptionService: EncryptionService,
    private readonly kubernetesService: KubernetesService,
  ) {}

  /**
   * Create a new K3s cluster
   */
  async createCluster(
    dto: CreateClusterDto,
  ): Promise<InfrastructureOperationEntity> {
    // Validate request
    await this.clusterValidationService.validateCreateClusterRequest(dto);

    // Delegate to creation service
    return await this.clusterCreationService.createCluster(dto);
  }

  /**
   * Delete a cluster
   */
  async deleteCluster(
    clusterId: string,
    force: boolean = false,
  ): Promise<InfrastructureOperationEntity> {
    // Delegate to deletion service
    return await this.clusterDeletionService.deleteCluster(clusterId, force);
  }

  /**
   * Get cluster by ID
   */
  async getCluster(
    clusterId: string,
    includeRealStatus: boolean = false,
  ): Promise<ClusterResponseDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    // If real-time status is requested, enrich with provider data
    if (includeRealStatus) {
      return this.clusterPowerManagementService.enrichClusterWithRealStatus(
        cluster,
      );
    }

    return this.clusterMapperService.mapToDto(cluster);
  }

  /**
   * List all clusters (excluding deleted)
   */
  async listClusters(): Promise<ClusterResponseDto[]> {
    const clusters = await this.clusterRepository.find({
      where: {
        status: Not(ClusterStatus.DELETED),
      },
      relations: ['nodes'],
      order: {
        createdAt: 'DESC',
      },
    });

    return this.clusterMapperService.mapToDtos(clusters);
  }

  /**
   * Register an existing externally-managed cluster
   */
  async registerCluster(
    dto: RegisterClusterDto,
  ): Promise<RegisterClusterResponseDto> {
    return await this.clusterOperationsService.registerCluster(dto);
  }

  /**
   * Get cluster entity by ID (for internal use)
   */
  async getClusterEntity(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    return cluster;
  }

  /**
   * Get kubeconfig for cluster
   */
  async getKubeconfig(clusterId: string): Promise<string> {
    return await this.clusterOperationsService.getKubeconfig(clusterId);
  }

  /**
   * Get cluster nodes
   */
  async getClusterNodes(clusterId: string): Promise<ClusterNodeEntity[]> {
    return await this.clusterOperationsService.getClusterNodes(clusterId);
  }

  async registerByosNode(
    clusterId: string,
    input: {
      serverName: string;
      nodeType?: 'worker' | 'master';
      ipAddress?: string;
      privateIp?: string;
      byos?: { host?: string; port?: number; user?: string };
    },
  ): Promise<ClusterNodeEntity> {
    return await this.clusterOperationsService.registerByosNode(
      clusterId,
      input,
    );
  }

  /**
   * Update cluster metadata
   */
  async updateClusterMetadata(
    clusterId: string,
    metadata: Record<string, any>,
  ): Promise<ClusterResponseDto> {
    return await this.clusterOperationsService.updateClusterMetadata(
      clusterId,
      metadata,
    );
  }

  /**
   * Update node metadata
   */
  async updateNodeMetadata(
    clusterId: string,
    nodeId: string,
    metadata: Record<string, any>,
  ): Promise<ClusterNodeEntity> {
    return await this.clusterOperationsService.updateNodeMetadata(
      clusterId,
      nodeId,
      metadata,
    );
  }

  /**
   * Reconcile cluster tags (deprecated - stub implementation)
   */
  async reconcileClusterTags(
    clusterId: string,
    force: boolean,
    includeFirewalls: boolean,
  ): Promise<any> {
    return await this.clusterOperationsService.reconcileClusterTags(
      clusterId,
      force,
      includeFirewalls,
    );
  }

  /**
   * Reconcile cluster firewalls (deprecated - use new desired-state API)
   */
  async reconcileClusterFirewalls(
    clusterId: string,
    options: { force: boolean; autoMatchTemplates: boolean },
  ): Promise<any> {
    return await this.clusterOperationsService.reconcileClusterFirewalls(
      clusterId,
      options,
    );
  }

  /**
   * Stop all servers in a cluster (async operation)
   */
  async stopCluster(
    clusterId: string,
  ): Promise<ClusterPowerOperationResponseDto> {
    return await this.clusterPowerManagementService.stopClusterAsync(clusterId);
  }

  /**
   * Start all servers in a cluster (async operation)
   */
  async startCluster(
    clusterId: string,
  ): Promise<ClusterPowerOperationResponseDto> {
    return await this.clusterPowerManagementService.startClusterAsync(
      clusterId,
    );
  }

  /**
   * Reconcile cluster status with real provider state
   */
  async reconcileClusterStatus(
    clusterId: string,
    autoFix: boolean = false,
  ): Promise<ReconcileStatusResponseDto> {
    return await this.clusterPowerManagementService.reconcileClusterStatus(
      clusterId,
      autoFix,
    );
  }

  /**
   * Check whether a cluster has sufficient resources for a new deployment.
   *
   * @param clusterId      - Target cluster UUID
   * @param cpuRequest     - CPU request in millicores (e.g. 250 for "250m")
   * @param memoryRequest  - Memory request in mebibytes (e.g. 256 for "256Mi")
   * @param replicas       - Number of replicas (default 1)
   * @param profileName    - Human-readable profile name for the response (optional)
   */
  async checkResourceAvailability(
    clusterId: string,
    cpuRequest: number,
    memoryRequest: number,
    replicas: number = 1,
    profileName: string | null = null,
  ): Promise<ResourceAvailabilityResponseDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const kubeconfig = await this.getKubeconfig(clusterId);

    const [total, used] = await Promise.all([
      this.kubernetesService.getNodeAllocatable(kubeconfig),
      this.kubernetesService.getPodResourceRequests(kubeconfig),
    ]);

    // Apply 10% safety margin
    const availableCpu = Math.floor(total.cpu * 0.9) - used.cpu;
    const availableMemory = Math.floor(total.memory * 0.9) - used.memory;

    const requiredCpu = cpuRequest * replicas;
    const requiredMemory = memoryRequest * replicas;

    const hasEnoughCpu = availableCpu >= requiredCpu;
    const hasEnoughMemory = availableMemory >= requiredMemory;
    const autoscalingEnabled = cluster.autoscalingEnabled ?? false;

    let canDeploy: boolean;
    let reason: ResourceAvailabilityReason = null;

    if (hasEnoughCpu && hasEnoughMemory) {
      canDeploy = true;
    } else if (autoscalingEnabled) {
      canDeploy = true;
      reason = 'autoscaling_pending';
    } else {
      canDeploy = false;
      reason = 'insufficient_resources';
    }

    const formatCpu = (mc: number) => `${mc}m`;
    const formatMem = (mi: number) =>
      mi >= 1024 ? `${(mi / 1024).toFixed(1).replace('.0', '')}Gi` : `${mi}Mi`;

    return {
      canDeploy,
      reason,
      profile: profileName,
      required: {
        cpu: formatCpu(requiredCpu),
        memory: formatMem(requiredMemory),
      },
      available: {
        cpu: formatCpu(Math.max(availableCpu, 0)),
        memory: formatMem(Math.max(availableMemory, 0)),
      },
      total: { cpu: formatCpu(total.cpu), memory: formatMem(total.memory) },
      used: { cpu: formatCpu(used.cpu), memory: formatMem(used.memory) },
      autoscalingEnabled,
    };
  }

  async getBuildResources(
    clusterId: string,
  ): Promise<BuildResourcesResponseDto> {
    const check = await this.checkResourceAvailability(
      clusterId,
      BUILD_JOB_CPU_REQUEST,
      BUILD_JOB_MEMORY_REQUEST,
    );

    let status: BuildResourceStatus;
    if (check.canDeploy && check.reason === null) {
      status = 'ok';
    } else if (check.autoscalingEnabled) {
      status = 'autoscaling_required';
    } else {
      status = 'insufficient';
    }

    return {
      status,
      required: check.required,
      available: check.available,
      total: check.total,
      used: check.used,
      autoscalingEnabled: check.autoscalingEnabled,
    };
  }
}
