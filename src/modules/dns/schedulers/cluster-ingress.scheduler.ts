import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { ClusterIngressReconciler } from '../services/cluster-ingress.reconciler';

/**
 * Measures, once a minute, which nodes of each cluster can take traffic, and
 * moves the cluster's public names when that set changes. Together with the
 * 60-second TTL of a multi-node name, this is what bounds how long a failed
 * node keeps receiving visitors.
 */
@Injectable()
export class ClusterIngressScheduler {
  private readonly logger = new Logger(ClusterIngressScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly reconciler: ClusterIngressReconciler,
  ) {}

  @Cron(process.env.FLUI_INGRESS_RECONCILE_CRON || CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (process.env.FLUI_INGRESS_RECONCILE === 'false') return;
    if (this.running) return;
    this.running = true;
    try {
      const clusters = await this.clusters.find({
        where: { status: ClusterStatus.READY },
        select: { id: true, name: true },
      });
      for (const cluster of clusters) {
        const outcome = await this.reconciler
          .reconcile(cluster.id)
          .catch((err: unknown) => ({
            state: 'unmeasured' as const,
            reason: err instanceof Error ? err.message : JSON.stringify(err),
          }));
        if (outcome.state === 'unmeasured') {
          this.logger.debug(
            `[ingress] ${cluster.name} not measured: ${outcome.reason}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
