import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import { WireGuardPeerService } from './wireguard-peer.service';
import { pairNodesWithTargets } from './wireguard-node-targets';
import { WireGuardHubService } from './wireguard-hub.service';
import {
  APPLIED_MARKER,
  buildApplyScript,
  buildKeyEnrolmentScript,
  extractPublicKey,
  READY_MARKER,
  UNSUPPORTED_MARKER,
} from '../wireguard-host';

export interface ClusterReconcileResult {
  enrolled: number;
  applied: number;
  revoked: number;
  unsupported: number;
  failed: NodeEnrolmentOutcome[];
}

export interface NodeEnrolmentOutcome {
  nodeId: string;
  host: string;
  publicKey?: string;
  managementIp?: string;
  unsupported?: boolean;
  error?: string;
}

/**
 * Carries the peer table's decisions onto the machines.
 *
 * Three steps, deliberately separate and separately re-runnable: learn each
 * node's public key, push the config it implies, then read back what the
 * kernel actually has. Collapsing them into one call would mean a failure in
 * the middle leaves no way to resume from where it stopped.
 */
@Injectable()
export class WireGuardReconciler {
  private readonly logger = new Logger(WireGuardReconciler.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly peerService: WireGuardPeerService,
    private readonly hostCommand: HostCommandService,
    private readonly hub: WireGuardHubService,
  ) {}

  /**
   * Brings a cluster's overlay to the state its topology implies.
   *
   * Desired state, not a sequence of steps: it is safe to run at any moment,
   * repeatedly, and after a failure halfway through. That property is what lets
   * it be attached to node creation, node removal and a periodic sweep without
   * three different code paths — and it is the only honest way to survive a
   * scale-up that half-succeeded.
   *
   * Order matters in one place: peers of departed nodes are withdrawn *before*
   * the remaining configs are written, so a node that has just been removed
   * stops being routable rather than lingering in everyone's config until the
   * next pass.
   */
  async reconcileCluster(clusterId: string): Promise<ClusterReconcileResult> {
    const cluster = await this.loadCluster(clusterId);
    const nodeIds = new Set((cluster.nodes ?? []).map((n) => n.id));

    const stale = (await this.peerService.livePeers()).filter(
      (p) => p.clusterId === clusterId && p.nodeId && !nodeIds.has(p.nodeId),
    );
    for (const peer of stale) {
      await this.peerService.revokeMember(peer.nodeId as string);
    }

    const enrolments = await this.enrolCluster(clusterId);
    // Before the members' own configs: a node that just presented a key is not
    // reachable from the hub until the hub's config names it, and waiting for
    // the next sweep to do that is a ten-minute silence for no reason.
    if (enrolments.some((o) => o.publicKey))
      await this.hub.applyControlConfig();
    const applications = await this.applyCluster(clusterId);

    const failed = [...enrolments, ...applications].filter((o) => o.error);
    return {
      revoked: stale.length,
      enrolled: enrolments.filter((o) => o.publicKey).length,
      applied: applications.filter((o) => !o.error && !o.unsupported).length,
      unsupported: enrolments.filter((o) => o.unsupported).length,
      failed,
    };
  }

  /**
   * Asks every node of a cluster for its public key, creating it there if it
   * does not exist, and records the result.
   *
   * One node failing does not abort the rest: a cluster where three of four
   * nodes can be enrolled is more useful than one where none were, and the
   * failures are returned rather than thrown so the caller can report exactly
   * which host refused and why.
   */
  async enrolCluster(clusterId: string): Promise<NodeEnrolmentOutcome[]> {
    const cluster = await this.loadCluster(clusterId);
    const script = buildKeyEnrolmentScript();
    const outcomes: NodeEnrolmentOutcome[] = [];

    for (const { node, target } of pairNodesWithTargets(cluster, this.logger)) {
      const outcome: NodeEnrolmentOutcome = {
        nodeId: node.id,
        host: target.host,
      };
      try {
        const out = await this.hostCommand.apply(target, script, READY_MARKER, {
          // Installing wireguard-tools on a cold apt cache is slower than the
          // default; a timeout here would leave a half-installed host.
          timeoutMs: 180_000,
        });
        if (out.includes(UNSUPPORTED_MARKER)) {
          outcome.unsupported = true;
          this.logger.warn(
            `[wg] ${target.host} cannot run WireGuard — skipping it`,
          );
        } else {
          const publicKey = extractPublicKey(out);
          if (!publicKey) {
            outcome.error = 'node did not return a usable public key';
          } else {
            const peer = await this.peerService.enrolMember({
              clusterId,
              nodeId: node.id,
              publicKey,
              subnetId: await this.managedSubnetOf(cluster),
              endpointHost: node.ipAddress ?? undefined,
            });
            outcome.publicKey = publicKey;
            outcome.managementIp = peer.managementIp;
          }
        }
      } catch (error) {
        outcome.error = (error as Error).message;
        this.logger.error(
          `[wg] enrolment failed on ${target.host}: ${outcome.error}`,
        );
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /**
   * Pushes each enrolled node the config its peer record implies.
   *
   * Renders per node rather than once for the cluster: every member's config
   * names its own address, and a shared one would hand several nodes the same
   * identity.
   */
  async applyCluster(clusterId: string): Promise<NodeEnrolmentOutcome[]> {
    const cluster = await this.loadCluster(clusterId);
    const outcomes: NodeEnrolmentOutcome[] = [];

    for (const { node, target } of pairNodesWithTargets(cluster, this.logger)) {
      const outcome: NodeEnrolmentOutcome = {
        nodeId: node.id,
        host: target.host,
      };
      try {
        const config = await this.peerService.renderConfigFor(node.id);
        const out = await this.hostCommand.apply(
          target,
          buildApplyScript(config),
          APPLIED_MARKER,
        );
        if (out.includes(UNSUPPORTED_MARKER)) outcome.unsupported = true;
      } catch (error) {
        outcome.error = (error as Error).message;
        this.logger.error(
          `[wg] apply failed on ${target.host}: ${outcome.error}`,
        );
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /**
   * The Flui-built subnet this cluster sits on, if any.
   *
   * A cluster records its network the same way whether the provider built it or
   * Flui did; the peer service is what tells the two apart, so the answer is
   * asked for rather than inferred from the provider name — BYOS can be either.
   */
  private async managedSubnetOf(
    cluster: ClusterEntity,
  ): Promise<string | undefined> {
    const subnetId = (
      cluster.metadata as { vnetConfig?: { subnetId?: string } } | null
    )?.vnetConfig?.subnetId;
    return this.peerService.managedSubnetId(subnetId);
  }

  private async loadCluster(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    return cluster;
  }
}
