import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { ClusterMapperService } from './cluster-mapper.service';
import { ClusterResponseDto } from '../dto/cluster-response.dto';
import {
  RegisterClusterDto,
  RegisterClusterResponseDto,
} from '../dto/register-cluster.dto';
import { ProviderFactory } from '../../../providers/services/provider.factory';
import { LabelService } from '../../shared/services/label.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { ByosVNetService } from './byos-vnet.service';

/**
 * Service for additional cluster operations
 * (kubeconfig, nodes, metadata updates, registration, etc.)
 */
@Injectable()
export class ClusterOperationsService {
  private readonly logger = new Logger(ClusterOperationsService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly clusterMapperService: ClusterMapperService,
    private readonly providerFactory: ProviderFactory,
    private readonly labelService: LabelService,
    private readonly byosVNetService: ByosVNetService,
  ) {}

  /**
   * Register an existing externally-managed cluster
   */
  async registerCluster(
    dto: RegisterClusterDto,
  ): Promise<RegisterClusterResponseDto> {
    this.logger.log(`📝 Registering external cluster: ${dto.name}`);
    this.logger.debug(`📊 Registration Data:`);
    this.logger.debug(`   - Name: ${dto.name}`);
    this.logger.debug(`   - Provider: ${dto.provider}`);
    this.logger.debug(`   - Region: ${dto.region}`);
    this.logger.debug(`   - Master IP: ${dto.masterIpAddress}`);
    this.logger.debug(
      `   - Cluster Type: ${dto.metadata?.isControlCluster || dto.metadata?.isObservabilityCluster ? 'CONTROL' : 'WORKLOAD'}`,
    );
    this.logger.debug(`   - K3s Version: ${dto.k3sVersion || 'not provided'}`);

    // Allow re-registration (upsert): check by CLI-provided ID first, then by name
    if (dto.clusterId) {
      const existingById = await this.clusterRepository.findOne({
        where: { id: dto.clusterId },
        relations: ['nodes'],
      });
      if (existingById) {
        this.logger.log(
          `Cluster with ID '${dto.clusterId}' already exists, deleting and re-creating...`,
        );
        await this.clusterRepository.remove(existingById);
      }
    }

    const existingCluster = await this.clusterRepository.findOne({
      where: { name: dto.name },
      relations: ['nodes'],
    });

    if (existingCluster) {
      this.logger.log(
        `Cluster '${dto.name}' already exists, deleting and re-creating...`,
      );
      await this.clusterRepository.remove(existingCluster);
    }

    const kubeconfigEncrypted = dto.kubeconfigEncrypted;
    const isControl = !!(
      dto.metadata?.isControlCluster || dto.metadata?.isObservabilityCluster
    );

    if (!kubeconfigEncrypted && !isControl) {
      throw new BadRequestException(
        'kubeconfigEncrypted is required for cluster registration',
      );
    }

    const clusterType =
      dto.metadata?.isControlCluster || dto.metadata?.isObservabilityCluster
        ? ClusterType.CONTROL
        : ClusterType.WORKLOAD;

    const cluster = this.clusterRepository.create({
      ...(dto.clusterId ? { id: dto.clusterId } : {}),
      name: dto.name,
      provider: dto.provider,
      region: dto.region,
      nodeSize: dto.nodeSize,
      nodeCount: 1,
      status: ClusterStatus.READY,
      clusterType,
      k3sTokenEncrypted: dto.k3sTokenEncrypted,
      kubeconfigEncrypted,
      k3sVersion: dto.k3sVersion,
      image: dto.image,
      sshKeyIds: dto.sshKeyIds || [],
      masterIpAddress: dto.masterIpAddress,
      metadata: {
        ...dto.metadata,
        externallyManaged: true,
        registeredAt: new Date().toISOString(),
        masterIpAddress: dto.masterIpAddress,
      },
    });

    const savedCluster = await this.clusterRepository.save(cluster);

    this.logger.debug(`✅ Cluster saved to database:`);
    this.logger.debug(`   - Cluster ID: ${savedCluster.id}`);
    this.logger.debug(`   - Cluster Type: ${savedCluster.clusterType}`);
    this.logger.debug(`   - Status: ${savedCluster.status}`);
    this.logger.debug(
      `   - masterIpAddress (direct field): ${savedCluster.masterIpAddress || 'NOT SET'}`,
    );
    this.logger.debug(
      `   - metadata.masterIpAddress: ${savedCluster.metadata?.masterIpAddress || 'NOT SET'}`,
    );

    // Create master node record (use .create() + .save() so @BeforeInsert() fires)
    const nodeEntity = this.nodeRepository.create({
      ...(dto.nodeId ? { id: dto.nodeId } : {}),
      clusterId: savedCluster.id,
      serverName: `${dto.name}-master`,
      nodeType: 'master' as any,
      status: 'ready' as any,
      ipAddress: dto.masterIpAddress,
      providerResourceId: dto.masterProviderResourceId || '',
      metadata: {
        externallyManaged: true,
      },
    });
    const savedNode = await this.nodeRepository.save(nodeEntity);

    this.logger.log(
      `✅ External cluster registered: ${savedCluster.id} (${savedCluster.clusterType})`,
    );
    this.logger.log(
      `   Master node: ${savedNode.serverName} (${dto.masterIpAddress})`,
    );

    if (savedNode.providerResourceId && dto.provider) {
      await this.tagClusterServer(savedCluster, savedNode, dto.provider);
    } else {
      this.logger.warn(
        `Skipping server tagging: providerResourceId or provider not available`,
      );
    }

    return {
      cluster_id: savedCluster.id,
      node_id: savedNode.id,
      metrics_endpoint: `/api/v1/servers/${savedNode.id}/metrics`,
      status: 'registered',
    };
  }

  async getKubeconfig(clusterId: string): Promise<string> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    if (!cluster.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Kubeconfig not available for cluster ${clusterId}`,
      );
    }

    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    const override = process.env.KUBECONFIG_SERVER_OVERRIDE;
    if (override) {
      return kubeconfig.replaceAll(
        /server:\s*https?:\/\/[^\s]+/g,
        `server: ${override}`,
      );
    }
    return kubeconfig;
  }

  async registerByosNode(
    clusterId: string,
    input: {
      serverName: string;
      nodeType?: 'worker' | 'master';
      ipAddress?: string;
      privateIp?: string;
      status?: 'joining' | 'ready';
      byos?: { host?: string; port?: number; user?: string };
    },
  ): Promise<ClusterNodeEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    if (cluster.provider !== CloudProvider.BYOS) {
      throw new BadRequestException(
        'Manual node registration is only supported for BYOS clusters; ' +
          'provisioned providers add nodes via POST /workers.',
      );
    }

    const nodeType = input.nodeType ?? 'worker';
    const byosMeta = input.byos
      ? {
          byos: {
            ...(input.byos.host ? { host: input.byos.host } : {}),
            port: input.byos.port ?? 22,
            user: input.byos.user ?? 'root',
          },
        }
      : {};

    const existing = (cluster.nodes ?? []).find(
      (n) => n.serverName === input.serverName,
    );
    const node =
      existing ??
      this.nodeRepository.create({
        clusterId,
        serverName: input.serverName,
        nodeType: nodeType as ClusterNodeEntity['nodeType'],
        providerResourceId: input.byos?.host || input.ipAddress || '',
      });

    node.nodeType = nodeType as ClusterNodeEntity['nodeType'];
    node.status = (input.status ?? 'ready') as ClusterNodeEntity['status'];
    if (input.ipAddress) node.ipAddress = input.ipAddress;
    if (input.privateIp) node.privateIp = input.privateIp;
    node.metadata = { ...node.metadata, externallyManaged: true, ...byosMeta };

    const saved = await this.nodeRepository.save(node);

    const total = await this.nodeRepository.count({ where: { clusterId } });
    await this.clusterRepository.update(clusterId, { nodeCount: total });

    try {
      const hasVNet = !!(
        cluster.metadata as { vnetConfig?: { vnetId?: string } }
      )?.vnetConfig?.vnetId;
      if (hasVNet) {
        await this.byosVNetService.attachNode(cluster, saved);
      } else {
        await this.byosVNetService.ensureClusterVNet(clusterId);
      }
    } catch (e) {
      this.logger.warn(
        `BYOS VNet attach/ensure skipped for ${saved.serverName}: ${(e as Error).message}`,
      );
    }

    this.logger.log(
      `✅ BYOS node registered on cluster ${clusterId}: ${saved.serverName} ` +
        `(${nodeType}, privateIp=${saved.privateIp ?? 'none'})`,
    );
    return saved;
  }

  async getClusterNodes(clusterId: string): Promise<ClusterNodeEntity[]> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    return cluster.nodes;
  }

  async updateClusterMetadata(
    clusterId: string,
    metadata: Record<string, any>,
  ): Promise<ClusterResponseDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    cluster.metadata = { ...cluster.metadata, ...metadata };
    const updated = await this.clusterRepository.save(cluster);

    return this.clusterMapperService.mapToDto(updated);
  }

  async updateNodeMetadata(
    clusterId: string,
    nodeId: string,
    metadata: Record<string, any>,
  ): Promise<ClusterNodeEntity> {
    const node = await this.nodeRepository.findOne({
      where: { id: nodeId, clusterId },
    });

    if (!node) {
      throw new NotFoundException(
        `Node ${nodeId} not found in cluster ${clusterId}`,
      );
    }

    node.metadata = { ...node.metadata, ...metadata };
    return await this.nodeRepository.save(node);
  }

  async reconcileClusterTags(
    clusterId: string,
    force: boolean,
    includeFirewalls: boolean,
  ): Promise<any> {
    return {
      clusterId,
      message: 'Tag reconciliation not yet implemented in new architecture',
      force,
      includeFirewalls,
    };
  }

  async reconcileClusterFirewalls(
    clusterId: string,
    options: { force: boolean; autoMatchTemplates: boolean },
  ): Promise<any> {
    return {
      clusterId,
      message:
        'Firewall reconciliation uses new desired-state API. Use PUT /firewalls/:id/desired-rules and POST /firewalls/:id/reconcile instead.',
      ...options,
    };
  }

  private async tagClusterServer(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
    provider: CloudProvider,
  ): Promise<void> {
    try {
      const providerService = this.providerFactory.getProvider(provider);

      if (!providerService.updateServerLabels) {
        this.logger.warn(
          `Provider '${provider}' does not support label updates`,
        );
        return;
      }

      const serverDetails = await providerService.getServerDetailsAsDto(
        node.providerResourceId,
      );

      if (!serverDetails) {
        this.logger.warn(
          `Server ${node.providerResourceId} not found in provider`,
        );
        return;
      }

      const existingLabels = serverDetails.labels
        ? this.labelService.toRecord(serverDetails.labels)
        : {};

      const clusterLabels = this.labelService.generateServerLabels({
        resourceType: 'cluster-node',
        clusterId: cluster.id,
        clusterName: cluster.name,
        nodeId: node.id,
        nodeType: node.nodeType as 'master' | 'worker',
      });

      const mergedLabels = {
        ...existingLabels,
        ...this.labelService.toRecord(clusterLabels),
      };

      await providerService.updateServerLabels(
        node.providerResourceId,
        mergedLabels,
      );
    } catch (error) {
      this.logger.error(
        `Failed to tag server ${node.providerResourceId}: ${error.message}`,
        error.stack,
      );
    }
  }
}
