import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { ClusterDnsSpreadReconciler } from '../services/cluster-dns-spread.reconciler';

/** Puts the cluster DNS back on two nodes after K3s rewrites it to one. */
@Injectable()
export class ClusterDnsSpreadScheduler {
  private readonly logger = new Logger(ClusterDnsSpreadScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly reconciler: ClusterDnsSpreadReconciler,
  ) {}

  @Cron(
    process.env.FLUI_CLUSTER_DNS_SPREAD_CRON || CronExpression.EVERY_5_MINUTES,
  )
  async tick(): Promise<void> {
    if (process.env.FLUI_CLUSTER_DNS_SPREAD === 'false') return;
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
            `[cluster-dns] ${cluster.name}: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
          );
        });
      }
    } finally {
      this.running = false;
    }
  }
}
