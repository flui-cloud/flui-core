import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';
import { VNetsService } from '../../vnets/services/vnets.service';
import { SubnetsService } from '../../vnets/services/subnets.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { VNetEntity } from '../../vnets/entities/vnet.entity';
import { VNetSubnetEntity } from '../../vnets/entities/vnet-subnet.entity';
import { nextFreeBlock } from '../../networking/wireguard-address-pool';
import { WireGuardPeerService } from '../../networking/services/wireguard-peer.service';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';

/**
 * One `/24` per cluster: 254 nodes is far past anything this serves, and a /16
 * then holds 256 clusters. Sized for legibility rather than density — an
 * operator reading `10.250.3.7` should be able to tell which cluster that is.
 */
export const CLUSTER_SUBNET_PREFIX = 24;

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
   * Puts this cluster on the network Flui builds, and gives every node of it an
   * address there.
   *
   * One network for the installation, one subnet per cluster. The subnet is the
   * isolation domain — nodes peer with the siblings of their own subnet and
   * with the control cluster, and with nobody else — which is why a cluster
   * does not get to pick one: two clusters sharing a subnet would silently join
   * their node networks.
   *
   * Nothing here is inferred from an address the machine already has: on any
   * host running containers that address is a container bridge, and two such
   * hosts would both report the same range while sharing nothing.
   */
  async ensureClusterVNet(
    clusterId: string,
    opts: { ipRange?: string } = {},
  ): Promise<EnsureByosVNetResult> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);

    // Asked of the provider rather than assumed from its name: the estates that
    // need a network built for them are the ones whose provider offers none,
    // and that is a property of the provider — Contabo is in the same position
    // as BYOS, while Hetzner and Scaleway have their own and must keep it.
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

    const network = await this.vnetsService.ensureFluiNetwork(opts.ipRange);
    const subnet = await this.ensureClusterSubnet(network, cluster);

    const metadata = {
      ...cluster.metadata,
      vnetConfig: {
        ...(cluster.metadata as any)?.vnetConfig,
        vnetId: network.id,
        subnetId: subnet.id,
      },
      byos: { ...(cluster.metadata as any)?.byos, nodeNetwork: subnet.ipRange },
    };
    await this.clusterRepository.update(clusterId, { metadata });

    const warnings: string[] = [];
    let attached = 0;
    for (const node of cluster.nodes ?? []) {
      // Reserved before the tunnel exists, so the address can go into the API
      // server certificate at first boot instead of after a restart.
      const ip = (
        await this.wireguard.reserveAddress({
          clusterId,
          nodeId: node.id,
          subnetId: subnet.id,
        })
      ).managementIp;
      if (node.privateIp !== ip) {
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
          `Flui network attach skipped for ${node.serverName}: ${(e as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Cluster ${clusterId} is on the Flui network at ${subnet.ipRange} ` +
        `(${attached} node(s) addressed)`,
    );
    return {
      vnetId: network.id,
      subnetId: subnet.id,
      ipRange: subnet.ipRange,
      attachedNodes: attached,
      warnings,
    };
  }

  /**
   * The block this cluster's nodes live on.
   *
   * Allocated once and remembered: the addresses inside it are already in
   * certificates and in other nodes' peer configs, so a cluster that came back
   * on a different block would be a different cluster to everyone else.
   */
  private async ensureClusterSubnet(
    network: VNetEntity,
    cluster: ClusterEntity,
  ): Promise<VNetSubnetEntity> {
    const recorded = (
      cluster.metadata as { vnetConfig?: { subnetId?: string } } | null
    )?.vnetConfig?.subnetId;
    const existing = (network.subnets ?? []).find((s) => s.id === recorded);
    if (existing) return existing;

    const taken = (network.subnets ?? []).map((s) => s.ipRange);
    const block = nextFreeBlock(network.ipRange, taken, CLUSTER_SUBNET_PREFIX);
    if (!block) {
      throw new BadRequestException(
        `The Flui network ${network.ipRange} has no free /${CLUSTER_SUBNET_PREFIX} ` +
          `left — ${taken.length} clusters are already on it.`,
      );
    }
    return this.vnetsService.ensureManualSubnet(network.id, block);
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
}
