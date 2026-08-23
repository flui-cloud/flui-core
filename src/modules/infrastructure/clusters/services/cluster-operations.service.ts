import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { ClusterMapperService } from './cluster-mapper.service';
import { ClusterResponseDto } from '../dto/cluster-response.dto';
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
    private readonly byosVNetService: ByosVNetService,
  ) {}

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
      // Same scoping as KubernetesService.patchKubeconfigServer: an optional
      // match keeps a multi-cluster dev setup from hijacking every cluster.
      const match = process.env.KUBECONFIG_SERVER_OVERRIDE_MATCH;
      return kubeconfig.replaceAll(/server:\s*https?:\/\/[^\s]+/g, (line) =>
        !match || line.includes(match) ? `server: ${override}` : line,
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
}
