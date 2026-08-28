import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { ProviderFactory } from '../../../providers/core/factories/provider.factory';
import { NodePriceService } from './node-price.service';

export interface NodeShapeBackfillResult {
  fromIntervals: number;
  fromProvider: number;
  priced: number;
}

/**
 * Fills the shape of nodes that predate it. Two sources, in order of trust:
 * the billable intervals, which already record a per-node provider, region and
 * server type, and then the provider itself for nodes that still exist there.
 *
 * A node whose shape stays unknown keeps null rather than inheriting the
 * cluster's single `nodeSize` — one wrong size on a heterogeneous fleet is
 * worse than an absent one.
 */
@Injectable()
export class NodeShapeBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NodeShapeBackfillService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    @InjectRepository(NodeBillableIntervalEntity)
    private readonly intervalRepository: Repository<NodeBillableIntervalEntity>,
    private readonly providerFactory: ProviderFactory,
    private readonly nodePriceService: NodePriceService,
  ) {}

  /**
   * At boot, not on a schedule: the shape of a node changes only when a node is
   * created or resized, and both of those write it themselves.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const clusters = await this.clusterRepository.find();
      const result = await this.backfill(clusters);
      if (result.fromIntervals || result.fromProvider || result.priced) {
        this.logger.log(
          `Node shapes backfilled: ${result.fromIntervals} from intervals, ` +
            `${result.fromProvider} from provider, ${result.priced} priced`,
        );
      }
    } catch (err) {
      this.logger.warn(`Node shape backfill failed: ${(err as Error).message}`);
    }
  }

  async backfill(clusters: ClusterEntity[]): Promise<NodeShapeBackfillResult> {
    const result: NodeShapeBackfillResult = {
      fromIntervals: 0,
      fromProvider: 0,
      priced: 0,
    };

    for (const cluster of clusters) {
      const nodes = await this.nodeRepository.find({
        where: [
          { clusterId: cluster.id, serverType: IsNull() },
          { clusterId: cluster.id, hourlyPriceEur: IsNull() },
        ],
      });

      for (const node of nodes) {
        try {
          await this.backfillNode(cluster, node, result);
        } catch (err) {
          this.logger.warn(
            `Shape backfill skipped for node ${node.id}: ${(err as Error).message}`,
          );
        }
      }
    }

    return result;
  }

  private async backfillNode(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
    result: NodeShapeBackfillResult,
  ): Promise<void> {
    const before = {
      serverType: node.serverType,
      region: node.region,
      price: node.hourlyPriceEur,
    };

    if (!node.serverType && (await this.fillFromIntervals(node))) {
      result.fromIntervals++;
    }
    if (!node.serverType && (await this.fillFromProvider(cluster, node))) {
      result.fromProvider++;
    }
    if (node.hourlyPriceEur == null && node.serverType) {
      node.hourlyPriceEur = await this.nodePriceService.resolveHourlyEur(
        node.provider,
        node.serverType,
        node.region,
      );
      if (node.hourlyPriceEur != null) result.priced++;
    }

    const changed =
      before.serverType !== node.serverType ||
      before.region !== node.region ||
      before.price !== node.hourlyPriceEur;
    if (changed) {
      await this.nodeRepository.save(node);
    }
  }

  private async fillFromIntervals(node: ClusterNodeEntity): Promise<boolean> {
    const interval = await this.intervalRepository.findOne({
      where: { nodeId: node.id },
      order: { startedAt: 'DESC' },
    });
    if (!interval) return false;

    // The intervals carry the provider's own name where BYOS had nothing to
    // record; carried across it would look like a location and a size.
    const isPlaceholder = (value?: string | null): boolean =>
      !value || value.toLowerCase() === interval.provider.toLowerCase();

    if (isPlaceholder(interval.serverType)) return false;

    node.serverType = interval.serverType;
    if (!node.region && !isPlaceholder(interval.region)) {
      node.region = interval.location ?? interval.region;
    }
    return true;
  }

  private async fillFromProvider(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<boolean> {
    const provider = node.provider as CloudProvider;
    if (
      !node.providerResourceId ||
      !this.providerFactory.getSupportedProviders().includes(provider)
    ) {
      return false;
    }

    const service = this.providerFactory.getProvider(provider);
    const details = await service.getServerDetailsAsDto(
      node.providerResourceId,
    );
    if (!details?.server_type) return false;

    node.serverType = details.server_type;
    node.region = details.location || node.region || cluster.region || null;
    return true;
  }
}
