import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { SharedVolumeModeReconciler } from '../services/shared-volume-mode.reconciler';

/**
 * Re-proves, every ten minutes, that each node of each cluster sees the shared
 * storage, and sets new volumes free of their node — or back onto it — to
 * match. Also undoes K3s putting its own storage settings back after an
 * upgrade.
 */
@Injectable()
export class SharedVolumeModeScheduler {
  private readonly logger = new Logger(SharedVolumeModeScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly reconciler: SharedVolumeModeReconciler,
  ) {}

  @Cron(process.env.FLUI_SHARED_VOLUMES_CRON || CronExpression.EVERY_10_MINUTES)
  async tick(): Promise<void> {
    if (process.env.FLUI_SHARED_VOLUMES_RECONCILE === 'false') return;
    if (this.running) return;
    this.running = true;
    try {
      const clusters = await this.clusters.find({
        where: { status: ClusterStatus.READY, sharedStorageEnabled: true },
        select: { id: true, name: true },
      });
      for (const cluster of clusters) {
        await this.reconciler.reconcile(cluster.id).catch((err: unknown) => {
          this.logger.warn(
            `[shared-volumes] ${cluster.name}: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
          );
        });
      }
    } finally {
      this.running = false;
    }
  }
}
