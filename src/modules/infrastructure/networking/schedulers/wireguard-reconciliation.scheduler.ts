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
import { WireGuardHubService } from '../services/wireguard-hub.service';
import { FluiNetworkBellService } from '../services/flui-network-bell.service';
import { managementNetworkOn } from '../management-network.state';

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
 * Off while the Flui network is switched off — and a no-op besides on installations whose
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
    private readonly hub: WireGuardHubService,
    private readonly bell: FluiNetworkBellService,
  ) {}

  @Cron(process.env.FLUI_WG_RECONCILE_CRON || CronExpression.EVERY_10_MINUTES)
  async tick(): Promise<void> {
    if (!managementNetworkOn()) return;
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
    // Before the hub's config is rendered, so the members of a destroyed
    // cluster leave it in this pass rather than lingering until the next one.
    try {
      await this.hub.revokeOrphanPeers();
    } catch (err: any) {
      this.logger.error(
        `[wg-reconcile] withdrawing departed peers failed: ${err?.message ?? err}`,
      );
    }

    // Then the control, and not conditionally: members dial it, so until its
    // end is up there is no overlay for any of them to join. A failure here is
    // logged and the pass continues — the workload loop below refuses on its
    // own when the control has no key, and one unreachable control should not
    // also cost the diagnostics the rest of the pass produces.
    let quiet = new Set<string>();
    try {
      const control = await this.hub.ensureControlEnd();
      if (control) {
        const wentQuiet = control.transitions.filter(
          (t) => t.kind === 'went-quiet',
        );
        quiet = new Set(wentQuiet.map((t) => t.peer.clusterId));
        for (const t of wentQuiet) {
          this.logger.warn(
            `[wg-reconcile] ${t.peer.managementIp} (cluster ${t.peer.clusterId}) went quiet — repairing it first`,
          );
        }
        await this.bell.ring(control.transitions);
      }
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

    // A cluster whose tunnel just went quiet is repaired before the rest.
    const ordered = [
      ...clusters.filter((c) => quiet.has(c.id)),
      ...clusters.filter((c) => !quiet.has(c.id)),
    ];
    for (const cluster of ordered) {
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
