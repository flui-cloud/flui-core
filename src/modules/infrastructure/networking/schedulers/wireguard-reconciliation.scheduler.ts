import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../../clusters/entities/cluster.entity';
import { WireGuardReconciler } from '../services/wireguard-reconciler.service';

/**
 * Brings every cluster's overlay back to its desired state on a loop.
 *
 * A periodic sweep rather than a hook on each lifecycle event, because
 * `reconcileCluster` is idempotent by construction and the events that would
 * need hooking are more numerous than they first appear: a node created, a node
 * removed, a node rebooted with a new public IP, a key rotated, an autoscale
 * that half-succeeded, a host that was unreachable during the last pass. One
 * loop covers all of them and cannot forget one; six hooks would eventually
 * disagree with each other.
 *
 * Off unless `FLUI_WG_ENABLED` — and a no-op besides on installations whose
 * clusters all share a private network, since none of them need the overlay.
 */
@Injectable()
export class WireGuardReconciliationScheduler {
  private readonly logger = new Logger(WireGuardReconciliationScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly reconciler: WireGuardReconciler,
  ) {}

  @Cron(process.env.FLUI_WG_RECONCILE_CRON || CronExpression.EVERY_10_MINUTES)
  async tick(): Promise<void> {
    if (process.env.FLUI_WG_ENABLED !== 'true') return;
    // SSH to every node of every cluster is not quick; overlapping ticks would
    // fight over the same interfaces.
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcileAll();
    } catch (err: any) {
      this.logger.error(`[wg-reconcile] tick failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One cluster failing must not stop the others: an unreachable host is the
   * ordinary case this loop exists to recover from, not a reason to abandon the
   * pass.
   */
  async reconcileAll(): Promise<void> {
    // First, and not conditionally: members dial the control, so until its end
    // is up there is no overlay for any of them to join. A failure here is
    // logged and the pass continues — the workload loop below refuses on its
    // own when the control has no key, and one unreachable control should not
    // also cost the diagnostics the rest of the pass produces.
    try {
      const control = await this.reconciler.ensureControlEnd();
      if (!control) {
        this.logger.warn(
          `[wg-reconcile] the control cluster has no end of the overlay — ` +
            `members cannot enrol until it does`,
        );
      } else if (!control.applied) {
        this.logger.warn(
          `[wg-reconcile] control peer recorded at ${control.address} but its ` +
            `config was not applied`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[wg-reconcile] control end failed: ${err?.message ?? err}`,
      );
    }

    const clusters = await this.clusters.find({
      where: {
        clusterType: In([ClusterType.WORKLOAD]),
        status: ClusterStatus.READY,
      },
    });

    for (const cluster of clusters) {
      try {
        const result = await this.reconciler.reconcileCluster(cluster.id);
        const touched =
          result.enrolled +
          result.applied +
          result.revoked +
          result.failed.length;
        if (touched > 0) {
          this.logger.log(
            `[wg-reconcile] ${cluster.name}: ${result.enrolled} enrolled, ` +
              `${result.applied} applied, ${result.revoked} revoked, ` +
              `${result.failed.length} failed, ${result.unsupported} unsupported`,
          );
        }
        for (const failure of result.failed) {
          this.logger.warn(
            `[wg-reconcile] ${cluster.name}/${failure.host}: ${failure.error}`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `[wg-reconcile] ${cluster.name} failed: ${err?.message ?? err}`,
        );
      }
    }
  }
}
