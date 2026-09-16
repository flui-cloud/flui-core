import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../../clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import { HostTarget } from '../../../providers/core/host/host-targets';
import { WireGuardPeerService } from './wireguard-peer.service';
import { VNetsService } from '../../vnets/services/vnets.service';
import { pairNodesWithTargets } from './wireguard-node-targets';
import {
  APPLIED_MARKER,
  READY_MARKER,
  UNSUPPORTED_MARKER,
  WireGuardInterfaceState,
  buildApplyScript,
  buildKeyEnrolmentScript,
  extractPublicKey,
  isHandshakeFresh,
  parseWireGuardDump,
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

/**
 * The hub end of the overlay: the control cluster's own interface, and the
 * membership of every other node on it.
 *
 * Separate from the per-cluster reconcile because the two answer different
 * questions. This one is about the single point every member dials; that one is
 * about a cluster's nodes. They run in the same sweep and in this order —
 * nothing can join a hub that is not up.
 */
@Injectable()
export class WireGuardHubService {
  private readonly logger = new Logger(WireGuardHubService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly peerService: WireGuardPeerService,
    private readonly hostCommand: HostCommandService,
    private readonly managementAddress: ManagementAddressResolver,
    private readonly vnets: VNetsService,
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
    const hub = await this.controlHub();
    if (!hub) return undefined;
    const { control, endpointHost, paired } = hub;

    // The row that models the overlay, created here rather than at install:
    // an installation that predates the overlay has no such row, and one that
    // only ran at install would leave it permanently without — invisible in
    // the one place an operator would look for it. Seeded with the range the
    // flat pool has been using, so addresses already handed out fall inside
    // the management block rather than beside it.
    try {
      await this.vnets.ensureFluiNetwork(process.env.FLUI_WG_POOL);
    } catch (error) {
      this.logger.warn(
        `[wg] could not record the Flui network: ${(error as Error).message}`,
      );
    }

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

    const applied = await this.applyControlConfig(paired.target);

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
   * Withdraws peers whose cluster no longer exists.
   *
   * `reconcileCluster` only ever runs for clusters that are still there, so a
   * cluster destroyed with members enrolled leaves them on the hub for good:
   * still in `wg show`, still routed, and their addresses never returned to the
   * pool.
   *
   * `deletedAt` is a plain column here, not a TypeORM soft-delete, so a
   * destroyed cluster still comes back from `find` and has to be filtered out
   * by hand.
   */
  async revokeOrphanPeers(): Promise<number> {
    const clusters = await this.clusters.find();
    const live = new Set(clusters.filter((c) => !c.deletedAt).map((c) => c.id));
    // An empty set reads as "the query told us nothing", not as "every cluster
    // is gone" — acting on that reading would dismantle the whole overlay.
    if (live.size === 0) return 0;

    let revoked = 0;
    for (const peer of await this.peerService.livePeers()) {
      if (!peer.nodeId || !peer.clusterId) continue;
      if (live.has(peer.clusterId)) continue;
      await this.peerService.revokeMember(peer.nodeId);
      revoked += 1;
    }
    if (revoked > 0) {
      this.logger.log(`[wg] withdrew ${revoked} peer(s) of departed clusters`);
    }
    return revoked;
  }

  /**
   * The control cluster's master and the address members dial it on.
   *
   * For BYOS the address is the operator-declared host: `masterIpAddress` there
   * can be something nothing outside can route to.
   */
  private async controlHub(): Promise<
    | {
        control: ClusterEntity;
        endpointHost: string;
        paired: { node: ClusterNodeEntity; target: HostTarget };
      }
    | undefined
  > {
    const control = await this.clusters.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
        status: ClusterStatus.READY,
      },
      relations: ['nodes'],
      order: { createdAt: 'ASC' },
    });
    if (!control) return undefined;

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
    const paired = pairNodesWithTargets(control, this.logger).find(
      (p) => p.node.id === master?.id,
    );
    return paired ? { control, endpointHost, paired } : undefined;
  }

  /**
   * Writes the hub's own config: every live member, one /32 each.
   *
   * Callable on its own because a member enrolled mid-sweep is otherwise only
   * routable from the control at the *next* sweep — the hub's config having
   * been written before that member had a key. Convergence in ten minutes where
   * it could be immediate.
   */
  async applyControlConfig(target?: HostTarget): Promise<boolean> {
    const host = target ?? (await this.controlHub())?.paired.target;
    if (!host) return false;

    const config = await this.peerService.renderControlConfig();
    if (!config) return false;
    try {
      await this.hostCommand.apply(
        host,
        buildApplyScript(config),
        APPLIED_MARKER,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `[wg] could not apply the control cluster's config: ${(error as Error).message}`,
      );
      return false;
    }
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
   * The kernel's own view of the interface.
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
}
