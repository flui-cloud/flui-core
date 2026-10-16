import { Injectable, Logger } from '@nestjs/common';
export type { ControlEndState, ControlNodeState } from './control-host-steps';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import { HostTarget } from '../../../providers/core/host/host-targets';
import {
  HandshakeTransition,
  WireGuardPeerService,
} from './wireguard-peer.service';
import { VNetsService } from '../../vnets/services/vnets.service';
import {
  APPLIED_MARKER,
  WireGuardInterfaceState,
  buildApplyScript,
  isHandshakeFresh,
  parseWireGuardDump,
} from '../wireguard-host';
import { WG_INTERFACE } from '../wireguard-config';
import {
  ControlEnd,
  ControlEndState,
  ControlHub,
  ControlNodeState,
  PairedNode,
  applyJumpHost,
  findControlHub,
  isLiveNode,
  jumpMemberAddresses,
  nodeEndpointHost,
  readNodeKey,
} from './control-host-steps';
import { WireGuardPeerRole } from '../entities/wireguard-peer.entity';
import { ControlReading } from './wireguard-control-peers';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import {
  controlEndFailed,
  controlEndWarned,
  recordControlEndHealth,
} from '../control-end-health';
import { endpointNameProblem } from '../control-endpoint-name';
import { withAdvisoryLockWaiting } from '../../../common/leadership/advisory-lock';

const CONTROL_END_LOCK = 'wg-control-end';

/**
 * The hub end of the overlay: every control node's own interface, and the
 * membership of every other node on it.
 *
 * Every control node is an end of its own, because the API runs as several
 * copies on any of them and a copy can only reach the members its own node
 * peers with. The master stays primary: its key is kept sealed, telemetry goes
 * to its address, and the jump user lives there.
 *
 * Separate from the per-cluster reconcile because the two answer different
 * questions. They run in the same sweep and in this order — nothing can join
 * a hub that is not up.
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
    private readonly encryption: EncryptionService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The control cluster's ends of the overlay, on every node of it.
   *
   * On the reconcile loop rather than at install time, deliberately: an
   * installation that switches the overlay on today has a control cluster built
   * without one, and a control node added later needs the same. Idempotent and
   * applied with `wg syncconf`: no K3s restart, no certificate change.
   *
   * One copy at a time: the leader's sweep and a control node's operation
   * both get here, and each would otherwise find no row and create one.
   */
  async ensureControlEnd(): Promise<ControlEndState | undefined> {
    return withAdvisoryLockWaiting(this.dataSource, CONTROL_END_LOCK, () =>
      this.convergeControlEnd(),
    );
  }

  private async convergeControlEnd(): Promise<ControlEndState | undefined> {
    const hub = await this.controlHub();
    if (!hub) return undefined;
    await this.recordFluiNetwork();
    const nameProblem = await endpointNameProblem(hub.endpointHost);
    controlEndWarned(nameProblem);
    if (nameProblem) this.logger.warn(`[wg] ${nameProblem}`);

    const key = await this.enrolPrimaryKey(hub.primary.target);
    if (!key) return undefined;
    const peer = await this.peerService.ensureControlPeer({
      clusterId: hub.control.id,
      nodeId: hub.primary.node.id,
      primary: true,
      publicKey: key.publicKey,
      endpointHost: hub.endpointHost,
    });
    if (key.captured) {
      await this.peerService.sealControlKey(
        this.encryption.encrypt(key.captured),
      );
      this.logger.log('[wg] the control key is now kept, sealed');
    }

    const ends: ControlEnd[] = [
      { paired: hub.primary, primary: true, row: peer },
    ];
    for (const other of hub.others) {
      ends.push(await this.enrolControlNode(hub.control, other));
    }
    await this.peerService.revokeDepartedControlPeers(
      hub.control.id,
      (hub.control.nodes ?? []).filter(isLiveNode).map((n) => n.id),
    );

    const nodes: ControlNodeState[] = [];
    let transitions: HandshakeTransition[] = [];
    for (const end of ends) {
      const state = await this.convergeEnd(end);
      nodes.push(state.node);
      if (end.primary) transitions = state.transitions;
    }
    recordControlEndHealth(nodes);
    const jumpHost = await this.ensureJumpHost(hub.primary.target);
    const primary = nodes[0];

    return {
      address: peer.managementIp,
      publicKey: key.publicKey,
      host: hub.primary.target.host,
      applied: nodes.every((n) => n.applied),
      fresh: primary.fresh,
      stale: primary.stale,
      transitions,
      jumpHost,
      nodes,
    };
  }

  /**
   * Takes a control node off the overlay before it is deleted, so no config
   * written afterwards still names it. The primary is never withdrawn: it
   * moves to the next master instead.
   */
  async withdrawControlNode(nodeId: string): Promise<boolean> {
    return withAdvisoryLockWaiting(
      this.dataSource,
      CONTROL_END_LOCK,
      async () => {
        const row = (await this.peerService.controlPeers()).find(
          (p) => p.nodeId === nodeId,
        );
        if (!row || row.isPrimary) return false;
        await this.peerService.revokeMember(nodeId);
        return true;
      },
    );
  }

  private async recordFluiNetwork(): Promise<void> {
    // The row that models the overlay, created here rather than at install:
    // an installation that predates the overlay has no such row. Seeded with
    // the range the flat pool has been using, so addresses already handed out
    // fall inside the management block rather than beside it.
    try {
      await this.vnets.ensureFluiNetwork(process.env.FLUI_WG_POOL);
    } catch (error) {
      this.logger.warn(
        `[wg] could not record the Flui network: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The master's key is the primary's identity on the network: kept sealed so
   * a rebuilt master is handed the same one and no member needs re-keying.
   */
  private async enrolPrimaryKey(
    target: HostTarget,
  ): Promise<{ publicKey: string; captured?: string } | undefined> {
    const sealed = await this.peerService.sealedControlKey();
    let restore: string | undefined;
    if (sealed) {
      try {
        restore = this.encryption.decrypt(sealed);
      } catch (error) {
        this.logger.error(
          `[wg] the kept control key cannot be opened (${(error as Error).message}) — leaving the master's key as it is`,
        );
      }
    }
    const key = await readNodeKey(this.hostCommand, target, {
      restore,
      capture: !sealed,
    });
    if (key.unsupported) {
      this.logger.warn(
        `[wg] the control cluster cannot run WireGuard — overlay unavailable`,
      );
      return undefined;
    }
    if (key.error) {
      const message = `could not read the control cluster's key: ${key.error}`;
      this.logger.error(`[wg] ${message}`);
      controlEndFailed(message);
      return undefined;
    }
    return key.publicKey
      ? { publicKey: key.publicKey, captured: key.captured }
      : undefined;
  }

  /** Any other control node: its own key, made on the node, never kept. */
  private async enrolControlNode(
    control: ClusterEntity,
    paired: PairedNode,
  ): Promise<ControlEnd> {
    const end: ControlEnd = { paired, primary: false };
    const endpointHost = nodeEndpointHost(paired.node);
    if (!endpointHost) {
      end.error = 'no public address members could dial';
      return end;
    }
    const key = await readNodeKey(this.hostCommand, paired.target);
    if (key.unsupported) end.error = 'cannot run WireGuard';
    else if (key.error) end.error = key.error;
    else if (!key.publicKey) end.error = 'did not return a usable public key';
    else {
      end.row = await this.peerService
        .ensureControlPeer({
          clusterId: control.id,
          nodeId: paired.node.id,
          publicKey: key.publicKey,
          endpointHost,
        })
        .catch((error: Error) => {
          end.error = error.message;
          return undefined;
        });
    }
    if (end.error) {
      this.logger.warn(`[wg] control node ${paired.target.host}: ${end.error}`);
    }
    return end;
  }

  private async convergeEnd(end: ControlEnd): Promise<{
    node: ControlNodeState;
    transitions: HandshakeTransition[];
  }> {
    const node: ControlNodeState = {
      nodeId: end.paired.node.id,
      host: end.paired.target.host,
      primary: end.primary,
      address: end.row?.managementIp,
      applied: false,
      fresh: 0,
      stale: 0,
      error: end.error,
    };
    if (!end.row) return { node, transitions: [] };
    node.applied = await this.applyOn(
      end.paired.target,
      end.paired.node.id,
      end.primary,
    );
    const health = await this.refreshFromControl(
      end.paired.target,
      end.row.id,
      end.primary,
    );
    node.fresh = health.fresh;
    node.stale = health.stale;
    if (!node.applied) node.error = node.error ?? 'its config was not applied';
    await this.peerService.markControlEnd(
      end.row.id,
      node.applied && health.read,
    );
    return { node, transitions: health.transitions };
  }

  private async ensureJumpHost(target: HostTarget): Promise<string> {
    let members: string[];
    try {
      const clusters = await this.clusters.find({
        select: { id: true, clusterType: true },
      });
      members = jumpMemberAddresses(
        clusters,
        await this.peerService.livePeers(),
      );
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`[wg] the jump user could not be set up: ${message}`);
      return `failed: ${message}`;
    }
    return applyJumpHost(this.hostCommand, this.logger, target, members);
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
      // The hub's own rows follow the control cluster's nodes in
      // ensureControlEnd: the primary moves to a rebuilt master rather than
      // leaving with the cluster it was first recorded on.
      if (peer.role === WireGuardPeerRole.CONTROL) continue;
      if (live.has(peer.clusterId)) continue;
      await this.peerService.revokeMember(peer.nodeId);
      revoked += 1;
    }
    if (revoked > 0) {
      this.logger.log(`[wg] withdrew ${revoked} peer(s) of departed clusters`);
    }
    return revoked;
  }

  private controlHub(): Promise<ControlHub | undefined> {
    return findControlHub(this.clusters, this.managementAddress, this.logger);
  }

  /**
   * Writes the hub's config, every live member one /32 each, on every control
   * node that has a row.
   *
   * Callable on its own because a member enrolled mid-sweep is otherwise only
   * routable from the control at the *next* sweep — the hub's config having
   * been written before that member had a key.
   */
  async applyControlConfig(): Promise<boolean> {
    const hub = await this.controlHub();
    if (!hub) return false;
    const rows = new Set(
      (await this.peerService.controlPeers()).map((r) => r.nodeId),
    );
    let all = true;
    for (const paired of [hub.primary, ...hub.others]) {
      const primary = paired === hub.primary;
      if (!primary && !rows.has(paired.node.id)) continue;
      if (!(await this.applyOn(paired.target, paired.node.id, primary))) {
        all = false;
      }
    }
    return all;
  }

  /**
   * One control node's config. `wg syncconf` and per-peer host routes: a pod
   * on this node reaches a member by the node's own overlay address, which is
   * what flannel's masquerade gives it.
   */
  private async applyOn(
    target: HostTarget,
    nodeId: string,
    primary: boolean,
  ): Promise<boolean> {
    const config = await this.peerService.renderControlConfig(nodeId);
    if (!config) return false;
    try {
      await this.hostCommand.apply(
        target,
        buildApplyScript(config),
        APPLIED_MARKER,
      );
      return true;
    } catch (error) {
      const message = `could not apply the control config on ${target.host}: ${(error as Error).message}`;
      this.logger.error(`[wg] ${message}`);
      if (primary) controlEndFailed(message);
      return false;
    }
  }

  /**
   * Writes back what one control node's kernel says about each member.
   *
   * Read on the control nodes and not on the members: they are the hosts
   * every member dials. The primary's reading decides a member's status and
   * the transitions the bell rings for; every node's reading is kept per node,
   * which is what proves a member is reachable from wherever the API runs.
   */
  async refreshFromControl(
    target: HostTarget,
    controlRowId?: string,
    primary = true,
  ): Promise<{
    fresh: number;
    stale: number;
    transitions: HandshakeTransition[];
    read: boolean;
  }> {
    let fresh = 0;
    let stale = 0;
    const transitions: HandshakeTransition[] = [];
    try {
      const state = await this.readState(target);
      const readings: ControlReading[] = [];
      for (const peer of state.peers) {
        const ok = isHandshakeFresh(peer);
        if (ok) fresh += 1;
        else stale += 1;
        readings.push({
          publicKey: peer.publicKey,
          fresh: ok,
          at: peer.latestHandshakeAt,
        });
        if (!primary) continue;
        const transition = await this.peerService.markHandshake(
          peer.publicKey,
          ok ? peer.latestHandshakeAt : undefined,
        );
        if (transition) transitions.push(transition);
      }
      if (controlRowId) {
        await this.peerService.recordControlReadings(controlRowId, readings);
      }
      return { fresh, stale, transitions, read: true };
    } catch (error) {
      this.logger.warn(
        `[wg] could not read the control's state on ${target.host}: ${(error as Error).message}`,
      );
      return { fresh, stale, transitions, read: false };
    }
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
