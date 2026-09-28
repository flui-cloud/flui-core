import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { SharedStorageExportReconciler } from '../services/shared-storage-export.reconciler';

/**
 * Brings every cluster's shared storage export in line with the networks Flui
 * knows for it. The reconciler only reaches a node when what it would write
 * has changed, so a quiet fleet costs a database read per cluster.
 */
@Injectable()
export class SharedStorageExportScheduler {
  private readonly logger = new Logger(SharedStorageExportScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly reconciler: SharedStorageExportReconciler,
  ) {}

  @Cron(
    process.env.FLUI_SHARED_STORAGE_EXPORT_CRON ||
      CronExpression.EVERY_10_MINUTES,
  )
  async tick(): Promise<void> {
    if (process.env.FLUI_SHARED_STORAGE_EXPORT_RECONCILE === 'false') return;
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcileAll();
    } catch (err) {
      this.logger.error(
        `[shared-storage] tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async reconcileAll(): Promise<void> {
    const clusters = await this.clusters.find({
      where: { status: ClusterStatus.READY, sharedStorageEnabled: true },
    });
    for (const cluster of clusters) {
      try {
        await this.reconciler.reconcile(cluster.id);
      } catch (err) {
        this.logger.error(
          `[shared-storage] ${cluster.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
