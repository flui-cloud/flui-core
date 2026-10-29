import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { NodeTopologyReconciler } from '../services/node-topology.reconciler';

/** Every half hour, labels any node that still lacks the zone and region its provider declares. */
@Injectable()
export class NodeTopologyScheduler {
  private readonly logger = new Logger(NodeTopologyScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly reconciler: NodeTopologyReconciler,
  ) {}

  @Cron(process.env.FLUI_NODE_TOPOLOGY_CRON || CronExpression.EVERY_30_MINUTES)
  async tick(): Promise<void> {
    if (process.env.FLUI_NODE_TOPOLOGY_RECONCILE === 'false') return;
    if (this.running) return;
    this.running = true;
    try {
      const clusters = await this.clusters.find({
        where: { status: ClusterStatus.READY },
        select: { id: true, name: true },
      });
      for (const cluster of clusters) {
        await this.reconciler.reconcile(cluster.id).catch((err: unknown) => {
          this.logger.warn(
            `[node-topology] ${cluster.name}: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
          );
        });
      }
    } finally {
      this.running = false;
    }
  }
}
