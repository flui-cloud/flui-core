import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { NodeBillableIntervalEntity } from '../entities/node-billable-interval.entity';
import { VolumeBillableIntervalEntity } from '../entities/volume-billable-interval.entity';
import { CostRatesService } from './cost-rates.service';

const KEEP_MONTHS = 13;

export interface CostRecordBackfillResult {
  nodesPriced: number;
  volumesPriced: number;
  named: number;
}

/**
 * Completes the cost record of lifetimes that predate it, while the clusters
 * they belong to still exist: the cluster's name, so the lifetime still reads
 * as "that cluster" after the cluster is gone, and the list price of its shape,
 * marked `list` because it is today's price and not the one it was bought at.
 *
 * Idempotent; runs at boot because a lifetime only gains a price when it opens.
 */
@Injectable()
export class CostRecordBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CostRecordBackfillService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(NodeBillableIntervalEntity)
    private readonly nodeIntervals: Repository<NodeBillableIntervalEntity>,
    @InjectRepository(VolumeBillableIntervalEntity)
    private readonly volumeIntervals: Repository<VolumeBillableIntervalEntity>,
    private readonly rates: CostRatesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.backfill();
      if (result.nodesPriced || result.volumesPriced || result.named) {
        this.logger.log(
          `Cost record completed: ${result.nodesPriced} node and ${result.volumesPriced} volume lifetimes priced, ${result.named} named`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Cost record backfill failed: ${(err as Error).message}`,
      );
    }
  }

  async backfill(now = new Date()): Promise<CostRecordBackfillResult> {
    const since = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - KEEP_MONTHS, 1),
    );
    const result: CostRecordBackfillResult = {
      nodesPriced: 0,
      volumesPriced: 0,
      named: 0,
    };

    const [nodes, volumes] = await Promise.all([
      incomplete(this.nodeIntervals, since),
      incomplete(this.volumeIntervals, since),
    ]);
    const clusterIds = [
      ...new Set([...nodes, ...volumes].map((row) => row.clusterId)),
    ];
    const clusters = clusterIds.length
      ? await this.clusterRepository.find({ where: { id: In(clusterIds) } })
      : [];
    const names = new Map(clusters.map((c) => [c.id, c.name]));

    for (const row of nodes) {
      const outcome = await this.complete(row, names.get(row.clusterId), () =>
        this.rates.stampNode(
          row.provider,
          row.serverType,
          row.region,
          row.location,
          'list',
        ),
      );
      if (!outcome) continue;
      await this.nodeIntervals.update(
        { id: row.id },
        {
          metadata: outcome.metadata as NodeBillableIntervalEntity['metadata'],
        },
      );
      if (outcome.named) result.named++;
      if (outcome.priced) result.nodesPriced++;
    }

    for (const row of volumes) {
      const outcome = await this.complete(row, names.get(row.clusterId), () =>
        this.rates.stampVolume(row.provider, 'list'),
      );
      if (!outcome) continue;
      await this.volumeIntervals.update(
        { id: row.id },
        {
          metadata:
            outcome.metadata as VolumeBillableIntervalEntity['metadata'],
        },
      );
      if (outcome.named) result.named++;
      if (outcome.priced) result.volumesPriced++;
    }

    return result;
  }

  /** The metadata to write, or null when this lifetime cannot be completed or needs nothing. */
  private async complete(
    row: { metadata: Record<string, unknown> },
    clusterName: string | undefined,
    stamp: () => Promise<unknown>,
  ): Promise<{
    metadata: Record<string, unknown>;
    named: boolean;
    priced: boolean;
  } | null> {
    if (!clusterName) return null;
    const metadata = { ...row.metadata };
    const named = !metadata.clusterName;
    if (named) metadata.clusterName = clusterName;
    let priced = false;
    if (!metadata.price) {
      const price = await stamp();
      if (price) {
        metadata.price = price;
        priced = true;
      }
    }
    return named || priced ? { metadata, named, priced } : null;
  }
}

function incomplete<
  T extends { metadata: Record<string, unknown>; endedAt?: Date | null },
>(repository: Repository<T>, since: Date): Promise<T[]> {
  return repository
    .createQueryBuilder('interval')
    .where('(interval.endedAt IS NULL OR interval.endedAt >= :since)', {
      since,
    })
    .getMany()
    .then((rows) =>
      rows.filter((row) => !row.metadata?.price || !row.metadata?.clusterName),
    );
}
