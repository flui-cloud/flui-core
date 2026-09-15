import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../entities/cluster.entity';
import { TelemetryEndpointReconciler } from '../services/telemetry-endpoint.reconciler';

/**
 * Keeps every workload cluster pushing its telemetry at an address that is
 * actually reachable.
 *
 * On a loop rather than on an event, for the same reason the overlay is: the
 * answer changes without anything happening *to this cluster*. The control's
 * address changes, a tunnel finishes handshaking, a node is added. One sweep
 * covers all of them and cannot forget one.
 *
 * Lives in the clusters module rather than beside the WireGuard sweep because
 * the reconciler it drives does: putting it the other way round would have the
 * networking module import clusters, which already imports networking.
 */
@Injectable()
export class TelemetryEndpointScheduler {
  private readonly logger = new Logger(TelemetryEndpointScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly reconciler: TelemetryEndpointReconciler,
  ) {}

  @Cron(
    process.env.FLUI_TELEMETRY_RECONCILE_CRON ||
      CronExpression.EVERY_30_MINUTES,
  )
  async tick(): Promise<void> {
    if (process.env.FLUI_TELEMETRY_RECONCILE !== 'true') return;
    // Rewriting Vector's config over SSH on every node is not quick, and two
    // passes would fight over the same file.
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcileAll();
    } catch (err: any) {
      this.logger.error(`[telemetry] tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One cluster failing must not stop the others: an unreachable node is the
   * ordinary case this loop exists to recover from.
   */
  async reconcileAll(): Promise<void> {
    const clusters = await this.clusters.find({
      where: { clusterType: ClusterType.WORKLOAD, status: ClusterStatus.READY },
    });

    for (const cluster of clusters) {
      try {
        // Logs and metrics, not just logs. They travel by different mechanisms —
        // Vector's config on each node, vmagent's arguments in the cluster — and
        // the last time only one of them was moved, the logs arrived and the
        // metrics quietly did not.
        // Caught separately: the two reach the node by different routes — the
        // Kubernetes API for metrics, SSH for logs — so one being unreachable
        // says nothing about the other, and letting it abort the iteration
        // would leave the logs pointing at the old address for no reason.
        try {
          const metrics = await this.reconciler.reconcileMetrics(cluster.id);
          if (metrics.changed) {
            this.logger.log(
              `[telemetry] ${cluster.name}: metrics repointed at ${metrics.endpoint}`,
            );
          } else if (metrics.reason) {
            this.logger.debug(
              `[telemetry] ${cluster.name}: metrics unchanged (${metrics.reason})`,
            );
          }
        } catch (err: any) {
          this.logger.warn(
            `[telemetry] ${cluster.name}: metrics not repointed: ${err?.message ?? err}`,
          );
        }

        const result = await this.reconciler.reconcile(cluster.id);
        if (result.updated > 0) {
          this.logger.log(
            `[telemetry] ${cluster.name}: ${result.updated} node(s) repointed ` +
              `at ${result.endpoint}, ${result.unchanged} already correct, ` +
              `${result.absent} without a config to rewrite`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `[telemetry] ${cluster.name} failed: ${err?.message ?? err}`,
        );
      }
    }
  }
}
