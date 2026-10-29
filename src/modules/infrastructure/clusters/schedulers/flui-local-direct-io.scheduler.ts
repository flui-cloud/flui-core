import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { FluiLocalDirectIoReconciler } from '../services/flui-local-direct-io.reconciler';

/**
 * Off unless `FLUI_LOCAL_DIRECT_IO_RECONCILE=true`: it changes the storage of
 * nodes that already hold data, so it stays opt-in until proven on a live
 * cluster. New nodes get direct I/O from their bootstrap script regardless.
 */
@Injectable()
export class FluiLocalDirectIoScheduler {
  private readonly logger = new Logger(FluiLocalDirectIoScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly reconciler: FluiLocalDirectIoReconciler,
  ) {}

  @Cron(process.env.FLUI_LOCAL_DIRECT_IO_CRON || CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    if (process.env.FLUI_LOCAL_DIRECT_IO_RECONCILE !== 'true') return;
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
            `[local-direct-io] ${cluster.name}: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
          );
        });
      }
    } finally {
      this.running = false;
    }
  }
}
