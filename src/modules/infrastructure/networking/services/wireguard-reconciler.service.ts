import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../../clusters/entities/cluster.entity';
import { NodeType } from '../../clusters/entities/cluster-node.entity';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { ClusterNodeEntity } from '../../clusters/entities/cluster-node.entity';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import {
  deriveHostTargets,
  HostTarget,
} from '../../../providers/core/host/host-targets';
import { WireGuardPeerService } from './wireguard-peer.service';
import {
  APPLIED_MARKER,
  buildApplyScript,
  buildKeyEnrolmentScript,
  extractPublicKey,
  isHandshakeFresh,
  parseWireGuardDump,
  READY_MARKER,
  UNSUPPORTED_MARKER,
  WireGuardInterfaceState,
} from '../wireguard-host';
import { WG_INTERFACE } from '../wireguard-config';

export interface ControlEndState {
  address: string;
  publicKey: string;
  host: string;
  applied: boolean;
  /** Members the control has seen a recent handshake from. */
  fresh: number;
  stale: number;
}

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
    private readonly managementAddress: ManagementAddressResolver,
  ) {}

  /**
   * The control cluster's own end of the overlay.
   *
   * Nothing else creates it, and without it there is no overlay at all: members
   * dial the control, so until the control has a key, an address and a
   * listening interface, every member config would name a peer that does not
   * exist and every enrolment would refuse.
   *
   * On the reconcile loop rather than at install time, deliberately: an
   * installation that switches the overlay on today has a control cluster built
   * without one, and a step that only ran at install would leave it permanently
   * without.
   */
  async ensureControlEnd(): Promise<ControlEndState | undefined> {
    const control = await this.clusters.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
        status: ClusterStatus.READY,
      },
      relations: ['nodes'],
      order: { createdAt: 'ASC' },
    });
    if (!control) return undefined;

    // The address members dial. For BYOS this is the operator-declared host:
    // `masterIpAddress` there can be something nothing outside can route to.
    const endpointHost = this.managementAddress.publicAddressOf(control);
    if (!endpointHost) {
      this.logger.warn(
        `[wg] the control cluster has no address members could dial — ` +
          `skipping its end of the overlay`,
      );
      return undefined;
    }

    const master = (control.nodes ?? []).find(
      (n) => n.nodeType === NodeType.MASTER,
    );
    const paired = this.pairNodesWithTargets(control).find(
      (p) => p.node.id === master?.id,
    );
    if (!paired) return undefined;

    let publicKey: string;
    try {
      const out = await this.hostCommand.apply(
        paired.target,
        buildKeyEnrolmentScript(),
        READY_MARKER,
        { timeoutMs: 180_000 },
      );
      if (out.includes(UNSUPPORTED_MARKER)) {
        this.logger.warn(
          `[wg] the control cluster cannot run WireGuard — overlay unavailable`,
        );
        return undefined;
      }
      const key = extractPublicKey(out);
      if (!key) return undefined;
      publicKey = key;
    } catch (error) {
      this.logger.error(
        `[wg] could not read the control cluster's key: ${(error as Error).message}`,
      );
      return undefined;
    }

    const peer = await this.peerService.ensureControlPeer({
      clusterId: control.id,
      publicKey,
      endpointHost,
    });

    // Every live member, one /32 each. Rendered and applied on every pass, so a
    // member enrolled since the last one becomes routable without anyone
    // remembering to push the control's side too.
    const config = await this.peerService.renderControlConfig();
    let applied = false;
    if (config) {
      try {
        await this.hostCommand.apply(
          paired.target,
          buildApplyScript(config),
          APPLIED_MARKER,
        );
        applied = true;
      } catch (error) {
        this.logger.error(
          `[wg] could not apply the control cluster's config: ${(error as Error).message}`,
        );
      }
    }

    // Read here because this is the one place already holding the control's
    // endpoint, and nothing downstream may act on a peer until it has
    // handshaken.
    const health = await this.refreshFromControl(paired.target);

    return {
      address: peer.managementIp,
      publicKey,
      host: paired.target.host,
      applied,
      ...health,
    };
  }

  /**
   * Writes back what the control cluster's kernel says about each member.
   *
   * Read here and not on the members: a member's `wg show` lists exactly one
   * peer — the control — so reading there records the control's freshness and
   * never a member's. Every consumer that asks "is this node reachable over the
   * tunnel" is asking about a member, and the only host that can answer for all
   * of them is the one they all dial.
   */
  async refreshFromControl(
    target: HostTarget,
  ): Promise<{ fresh: number; stale: number }> {
    let fresh = 0;
    let stale = 0;
    try {
      const state = await this.readState(target);
      for (const peer of state.peers) {
        const ok = isHandshakeFresh(peer);
        if (ok) fresh += 1;
        else stale += 1;
        await this.peerService.markHandshake(
          peer.publicKey,
          ok ? peer.latestHandshakeAt : undefined,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[wg] could not read the control's state: ${(error as Error).message}`,
      );
    }
    return { fresh, stale };
  }

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

    for (const { node, target } of this.pairNodesWithTargets(cluster)) {
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

    for (const { node, target } of this.pairNodesWithTargets(cluster)) {
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
   * Reads the kernel's own view and writes the handshakes back to the peer
   * table.
   *
   * The database records what Flui asked for; only `wg show` says what is
   * actually up. Anything that reports health from the former is reporting its
   * own intentions back to itself.
   */
  async readState(
    target: HostTarget,
    iface: string = WG_INTERFACE,
  ): Promise<WireGuardInterfaceState> {
    const dump = await this.hostCommand.run(
      target,
      `wg show ${iface} dump 2>/dev/null || true`,
    );
    return parseWireGuardDump(dump, iface);
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

  /**
   * Lines up nodes with the SSH endpoints derived for the cluster.
   *
   * `deriveHostTargets` answers per cluster, not per node, so the two are
   * matched on host address. A node with no matching endpoint is skipped rather
   * than guessed at: applying it on the wrong machine would give that machine
   * another node's identity on the overlay.
   */
  private pairNodesWithTargets(
    cluster: ClusterEntity,
  ): Array<{ node: ClusterNodeEntity; target: HostTarget }> {
    const targets = deriveHostTargets(cluster);
    const byHost = new Map(targets.map((t) => [t.host, t]));
    const paired: Array<{ node: ClusterNodeEntity; target: HostTarget }> = [];
    for (const node of cluster.nodes ?? []) {
      const byosHost = (
        node.metadata as { byos?: { host?: string } } | undefined
      )?.byos?.host;
      const target =
        (byosHost && byHost.get(byosHost)) ||
        (node.ipAddress ? byHost.get(node.ipAddress) : undefined);
      if (!target) {
        this.logger.warn(
          `[wg] node ${node.serverName ?? node.id} has no SSH endpoint among the cluster's — skipping`,
        );
        continue;
      }
      paired.push({ node, target });
    }
    return paired;
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
