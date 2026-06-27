import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeType } from '../entities/cluster-node.entity';
import { VNetsService } from '../../vnets/services/vnets.service';
import { SubnetsService } from '../../vnets/services/subnets.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

export interface EnsureByosVNetResult {
  vnetId: string;
  subnetId: string;
  ipRange: string;
  attachedNodes: number;
  warnings: string[];
}

@Injectable()
export class ByosVNetService {
  private readonly logger = new Logger(ByosVNetService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    private readonly vnetsService: VNetsService,
    private readonly subnetsService: SubnetsService,
  ) {}

  async ensureClusterVNet(
    clusterId: string,
    opts: { ipRange?: string } = {},
  ): Promise<EnsureByosVNetResult> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    if (cluster.provider !== CloudProvider.BYOS) {
      throw new BadRequestException(
        'Manual VNet registration is only supported for BYOS clusters.',
      );
    }

    const ipRange = this.resolveIpRange(cluster, opts.ipRange);

    const vnet = await this.vnetsService.registerManualVNet({
      clusterId,
      provider: CloudProvider.BYOS,
      name: `${cluster.name}-net`,
      ipRange,
    });
    const subnet = vnet.subnets[0];
    if (!subnet) {
      throw new BadRequestException(
        `Manual VNet ${vnet.id} has no subnet — cannot attach nodes.`,
      );
    }

    const metadata = {
      ...cluster.metadata,
      vnetConfig: {
        ...(cluster.metadata as any)?.vnetConfig,
        vnetId: vnet.id,
        subnetId: subnet.id,
      },
      byos: { ...(cluster.metadata as any)?.byos, nodeNetwork: ipRange },
    };
    await this.clusterRepository.update(clusterId, { metadata });

    const warnings: string[] = [];
    let attached = 0;
    for (const node of cluster.nodes ?? []) {
      const ip = node.privateIp?.trim();
      if (!ip) continue;
      try {
        await this.subnetsService.attachServerToSubnet(subnet.id, {
          serverId: node.id,
          ip,
        });
        if (node.subnetId !== subnet.id) {
          await this.nodeRepository.update(node.id, { subnetId: subnet.id });
        }
        attached += 1;
      } catch (e) {
        warnings.push(
          `Node ${node.serverName} (${ip}) not attached: ${(e as Error).message}`,
        );
        this.logger.warn(
          `BYOS VNet attach skipped for ${node.serverName}: ${(e as Error).message}`,
        );
      }
    }

    this.logger.log(
      `BYOS VNet ensured for cluster ${clusterId}: ${ipRange} (vnet ${vnet.id}, ${attached} node(s) attached)`,
    );
    return {
      vnetId: vnet.id,
      subnetId: subnet.id,
      ipRange,
      attachedNodes: attached,
      warnings,
    };
  }

  async attachNode(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<void> {
    const subnetId = (cluster.metadata as any)?.vnetConfig?.subnetId;
    const ip = node.privateIp?.trim() || node.ipAddress?.trim();
    if (!subnetId || !ip) return;
    await this.subnetsService.attachServerToSubnet(subnetId, {
      serverId: node.id,
      ip,
    });
    if (node.subnetId !== subnetId) {
      await this.nodeRepository.update(node.id, { subnetId });
    }
  }

  async detachNode(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<void> {
    const subnetId = (cluster.metadata as any)?.vnetConfig?.subnetId;
    if (!subnetId) return;
    await this.subnetsService.detachServerFromSubnet(subnetId, {
      serverId: node.id,
    });
  }

  private resolveIpRange(cluster: ClusterEntity, override?: string): string {
    if (override?.trim()) return override.trim();

    const declared = (cluster.metadata as any)?.byos?.nodeNetwork;
    if (typeof declared === 'string' && declared.trim()) return declared.trim();

    const master = (cluster.nodes ?? []).find(
      (n) => n.nodeType === NodeType.MASTER,
    );
    const masterIp = master?.privateIp || cluster.masterIpAddress;
    const slash24 = this.toSlash24(masterIp);
    if (slash24) return slash24;

    throw new BadRequestException(
      'Cannot determine the private network CIDR — pass ipRange (the subnet your nodes share).',
    );
  }

  private toSlash24(ip?: string): string | undefined {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(
      (ip ?? '').trim(),
    );
    return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : undefined;
  }
}
