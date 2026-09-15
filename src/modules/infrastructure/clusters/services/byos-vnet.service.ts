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
import { VNetImplementation } from '../../vnets/entities/vnet.entity';
import { WireGuardPeerService } from '../../networking/services/wireguard-peer.service';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';

/**
 * Where a Flui-built node network lives when nobody picks one.
 *
 * Inside 10/8 but far from both the k3s pod and service ranges and from the
 * addresses providers hand out in their own private networks, so a cluster that
 * later gains a real LAN does not find Flui already sitting on it.
 */
export const DEFAULT_MANAGED_NODE_NETWORK = '10.201.0.0/24';

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
    private readonly wireguard: WireGuardPeerService,
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
  ) {}

  /**
   * Registers the cluster's private network, whether the operator wired one or
   * Flui has to build it.
   *
   * The same flow serves both because the difference is narrow: where a node's
   * private address comes from. With an operator-wired LAN the node already has
   * one and Flui records it; with a Flui-built network there is none, so Flui
   * assigns it out of the subnet and the node reaches its siblings through the
   * tunnel that address lives on.
   *
   * Not a provider capability, deliberately. The same provider serves both
   * estates — one operator has a LAN, the next has four machines in four
   * datacentres — so the answer belongs to the cluster, not to a static table
   * that would have to lie for one of them.
   */
  async ensureClusterVNet(
    clusterId: string,
    opts: { ipRange?: string; implementation?: VNetImplementation } = {},
  ): Promise<EnsureByosVNetResult> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    const implementation =
      opts.implementation ?? VNetImplementation.PROVIDER_NATIVE;
    const fluiBuilt = implementation === VNetImplementation.WIREGUARD;

    if (fluiBuilt) {
      // Asked of the provider rather than assumed from its name: the estates
      // that need a network built for them are the ones whose provider offers
      // none, and that is a property of the provider, not of BYOS in
      // particular — Contabo is in exactly the same position.
      const capabilities = this.capabilitiesFactory
        .getCapabilitiesService(cluster.provider as CloudProvider)
        .getStaticCapabilities();
      if (!capabilities.supportsFluiManagedVNet) {
        throw new BadRequestException(
          `${cluster.provider} builds private networks of its own — Flui will ` +
            `not build a second one over the top. Attach the cluster to a ` +
            `${cluster.provider} network instead.`,
        );
      }
    } else if (cluster.provider !== CloudProvider.BYOS) {
      throw new BadRequestException(
        'Manual VNet registration is only supported for BYOS clusters.',
      );
    }
    const ipRange = fluiBuilt
      ? this.resolveManagedRange(cluster, opts.ipRange)
      : this.resolveIpRange(cluster, opts.ipRange);

    const vnet = await this.vnetsService.registerManualVNet({
      clusterId,
      // The cluster's own provider, not BYOS: a Flui-built network serves any
      // provider that offers none, and a row claiming the wrong one is a lie
      // every later lookup inherits.
      provider: cluster.provider as CloudProvider,
      name: `${cluster.name}-net`,
      ipRange,
      implementation,
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
      // Reserved before the tunnel exists, so the address can go into the API
      // server certificate at first boot instead of after a restart.
      const ip = fluiBuilt
        ? (
            await this.wireguard.reserveAddress({
              clusterId,
              nodeId: node.id,
              subnetId: subnet.id,
            })
          ).managementIp
        : node.privateIp?.trim();
      if (!ip) continue;
      if (fluiBuilt && node.privateIp !== ip) {
        await this.nodeRepository.update(node.id, { privateIp: ip });
      }
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

  /**
   * The range for a network Flui builds.
   *
   * Never derived from an address a node already has: guessing a range out of
   * a public IP would produce one the operator never chose.
   */
  private resolveManagedRange(
    cluster: ClusterEntity,
    override?: string,
  ): string {
    if (override?.trim()) return override.trim();
    const declared = (cluster.metadata as any)?.byos?.nodeNetwork;
    if (typeof declared === 'string' && declared.trim()) return declared.trim();
    return DEFAULT_MANAGED_NODE_NETWORK;
  }

  private toSlash24(ip?: string): string | undefined {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(
      (ip ?? '').trim(),
    );
    return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : undefined;
  }
}
