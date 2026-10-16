import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { FLUI_NETWORK_RESOURCE_ID } from '../../vnets/services/vnets.service';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { WireGuardLinkEntity } from '../entities/wireguard-link.entity';
import {
  WireGuardPeerEntity,
  WireGuardPeerRole,
  WireGuardPeerStatus,
} from '../entities/wireguard-peer.entity';
import {
  VNetEntity,
  VNetImplementation,
} from '../../vnets/entities/vnet.entity';
import {
  DEFAULT_MANAGEMENT_POOL,
  WireGuardAddressPool,
} from '../wireguard-address-pool';
import {
  BootstrapPeer,
  isWireGuardPublicKey,
  WG_DEFAULT_PORT,
} from '../wireguard-config';
import { managementNetworkOn } from '../management-network.state';
import {
  ControlPeerStore,
  ControlReading,
  EnsureControlPeerInput,
} from './wireguard-control-peers';
import { WireGuardPeerRenderer } from './wireguard-peer-render';

export interface EnrolMemberInput {
  clusterId: string;
  nodeId: string;
  publicKey: string;
  /** Isolation domain, for a Flui-managed VNet. Absent on the management
   *  overlay, where the control cluster is the only peer anyone has. */
  subnetId?: string | null;
  /** Public transport address, recorded for diagnostics and allow-lists. */
  endpointHost?: string;
}

/**
 * Owns the peer table: who is on the management overlay, at which address.
 *
 * Deliberately does not touch a host. Allocation and desired state are decided
 * here, applying them is someone else's job — that split is what lets the hard
 * part be tested without a machine, and it keeps a reconcile that fails
 * halfway from leaving the database describing a world that was never built.
 */
export interface HandshakeTransition {
  kind: 'went-quiet' | 'came-back';
  peer: WireGuardPeerEntity;
}

@Injectable()
export class WireGuardPeerService {
  private readonly logger = new Logger(WireGuardPeerService.name);
  private readonly controls: ControlPeerStore;
  private readonly renderer: WireGuardPeerRenderer;

  constructor(
    @InjectRepository(WireGuardPeerEntity)
    private readonly peers: Repository<WireGuardPeerEntity>,
    @InjectRepository(VNetEntity)
    private readonly vnets: Repository<VNetEntity>,
    @Optional()
    @InjectRepository(WireGuardLinkEntity)
    links?: Repository<WireGuardLinkEntity>,
  ) {
    this.controls = new ControlPeerStore(peers, async () =>
      (await this.pool()).allocate(await this.allocatedAddresses()),
    );
    this.renderer = new WireGuardPeerRenderer(peers, this.controls, links);
  }

  /**
   * The pool, checked against every private network Flui knows about.
   *
   * Rebuilt per call rather than cached: a VNet created after start-up would
   * otherwise never be considered, and the whole point is to notice an overlap
   * before an address is handed out inside it.
   */
  async pool(): Promise<WireGuardAddressPool> {
    const known = await this.vnets.find();

    // The management block of the Flui network, when there is one — not a
    // parallel space alongside it, which would put two allocators over the
    // same /16 and hand out addresses from a range nobody can see.
    // By resource id, which is the invariant `ensureFluiNetwork` maintains —
    // one row per installation. `implementation` is a property several rows
    // could share, and `find` would then pick whichever came back first.
    const fluiNetwork = known.find(
      (v) => v.providerResourceId === FLUI_NETWORK_RESOURCE_ID,
    );
    const managementSubnet = (fluiNetwork?.subnets ?? []).find(
      (s) => s.networkZone === 'management',
    );
    if (managementSubnet) {
      const others = known
        .flatMap((v) => (v.subnets ?? []).map((s) => s.ipRange))
        .filter((c): c is string => !!c && c !== managementSubnet.ipRange);
      return new WireGuardAddressPool(managementSubnet.ipRange, others);
    }

    // Before the network exists — the first boot of an installation, and every
    // installation that predates it.
    const cidrs = known
      .flatMap((v) => [v.ipRange, ...(v.subnets ?? []).map((s) => s.ipRange)])
      .filter((c): c is string => !!c);
    return new WireGuardAddressPool(
      process.env.FLUI_WG_POOL || DEFAULT_MANAGEMENT_POOL,
      cidrs,
    );
  }

  /**
   * The range one peer's address comes from.
   *
   * Two different questions share one allocator. The management overlay draws
   * from a flat pool nobody ever sees; a node inside a Flui-managed VNet draws
   * from the range the operator was shown when that network was created — the
   * same range the firewall rules name. An address from anywhere else would
   * make the network's own CIDR a lie.
   */
  async poolFor(subnetId?: string | null): Promise<WireGuardAddressPool> {
    if (!subnetId) return this.pool();

    const vnets = await this.vnets.find();
    const owner = vnets.find((v) =>
      (v.subnets ?? []).some((s) => s.id === subnetId),
    );
    const subnet = (owner?.subnets ?? []).find((s) => s.id === subnetId);
    if (!owner || !subnet) {
      throw new BadRequestException(`Subnet ${subnetId} does not exist`);
    }
    if (owner.implementation !== VNetImplementation.WIREGUARD) {
      throw new BadRequestException(
        `VNet ${owner.name} is provider-native: ${owner.provider} assigns its ` +
          `addresses, and Flui handing out a second set would produce two ` +
          `answers for where a node is.`,
      );
    }

    // Every other network, but not this one: a range must not be refused for
    // overlapping itself.
    const others = vnets
      .filter((v) => v.id !== owner.id)
      .flatMap((v) => [v.ipRange, ...(v.subnets ?? []).map((s) => s.ipRange)])
      .filter((c): c is string => !!c);
    return new WireGuardAddressPool(subnet.ipRange, others);
  }

  /**
   * The subnet id, but only when Flui is the one that built that network.
   *
   * A cluster records which subnet it sits on the same way whether the network
   * came from its provider or from Flui, and only the VNet knows which. Asking
   * here — rather than letting each caller inspect the VNet — is what keeps a
   * provider-assigned address and a Flui-assigned one from ever both being
   * handed to the same node.
   */
  async managedSubnetId(subnetId?: string | null): Promise<string | undefined> {
    if (!subnetId) return undefined;
    const vnets = await this.vnets.find();
    const owner = vnets.find((v) =>
      (v.subnets ?? []).some((sub) => sub.id === subnetId),
    );
    return owner?.implementation === VNetImplementation.WIREGUARD
      ? subnetId
      : undefined;
  }

  async livePeers(): Promise<WireGuardPeerEntity[]> {
    return this.peers.find({ where: { revokedAt: IsNull() } });
  }

  /**
   * Every address ever handed out, revoked ones included.
   *
   * Allocation must not look at live peers alone. A revoked peer's address has
   * to stay out of circulation, or a node enrolled tomorrow inherits the
   * identity of one retired today while stale configs elsewhere still name it —
   * and the two would be indistinguishable to anyone reading `wg show`. The
   * pool is a /16; running out means 65k enrolments, and it fails loudly.
   */
  private async allocatedAddresses(): Promise<string[]> {
    const all = await this.peers.find();
    return all.map((p) => p.managementIp).filter(Boolean);
  }

  /** The master's control row: the sealed key, and where telemetry goes. */
  async controlPeer(): Promise<WireGuardPeerEntity | null> {
    return this.controls.primary();
  }

  /** Every control node's row, the primary first. */
  async controlPeers(): Promise<WireGuardPeerEntity[]> {
    return this.controls.all();
  }

  /** The control's sealed private key, when one has been kept. */
  async sealedControlKey(): Promise<string | null> {
    return this.controls.sealedKey();
  }

  async sealControlKey(sealed: string): Promise<void> {
    return this.controls.seal(sealed);
  }

  /**
   * Records one control node's end of the overlay. The first one takes the
   * first address in the pool, which is convention rather than necessity:
   * every member's config names each control node explicitly.
   */
  async ensureControlPeer(
    params: EnsureControlPeerInput,
  ): Promise<WireGuardPeerEntity> {
    this.assertPublicKey(params.publicKey);
    return this.controls.ensure(params);
  }

  async revokeDepartedControlPeers(
    clusterId: string,
    nodeIds: string[],
  ): Promise<WireGuardPeerEntity[]> {
    const gone = await this.controls.revokeDeparted(clusterId, nodeIds);
    for (const row of gone) {
      this.logger.log(
        `[wg] control node ${row.nodeId} left — withdrew ${row.managementIp}`,
      );
    }
    return gone;
  }

  async markControlEnd(rowId: string, up: boolean): Promise<void> {
    return this.controls.markEnd(rowId, up);
  }

  async recordControlReadings(
    controlRowId: string,
    readings: ControlReading[],
  ): Promise<void> {
    return this.controls.recordReadings(controlRowId, readings);
  }

  /**
   * The control nodes that have not seen this node's tunnel recently. Empty
   * when every control node reaches it — the only state in which a copy of the
   * API, wherever it runs, can be pointed at the node's overlay address.
   */
  async controlsNotReaching(nodeId: string): Promise<WireGuardPeerEntity[]> {
    const member = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!member) return this.controls.all();
    return this.controls.notReaching(member);
  }

  /**
   * Reserves an address for a node that does not exist yet.
   *
   * The insight that makes this worth doing: the two halves of a peer's
   * identity come from different places. Flui owns the address and can assign
   * it before the machine is provisioned; only the node can produce the key.
   * Reserving early lets the address go into the API server certificate at
   * first boot, which is the difference between a cluster that never needs its
   * certificate regenerated and one that does — on a live master, with a
   * restart.
   */
  async reserveAddress(params: {
    clusterId: string;
    nodeId: string;
    subnetId?: string | null;
  }): Promise<WireGuardPeerEntity> {
    const existing = await this.peers.findOne({
      where: { nodeId: params.nodeId, revokedAt: IsNull() },
    });
    if (existing) return existing;

    const pool = await this.poolFor(params.subnetId);
    const taken = await this.allocatedAddresses();
    const peer = this.peers.create({
      clusterId: params.clusterId,
      nodeId: params.nodeId,
      role: WireGuardPeerRole.MEMBER,
      publicKey: null,
      managementIp: pool.allocate(taken),
      subnetId: params.subnetId ?? null,
      listenPort: params.subnetId ? WG_DEFAULT_PORT : null,
      status: WireGuardPeerStatus.PENDING,
    });
    this.logger.log(
      `[wg] address ${peer.managementIp} reserved for node ${params.nodeId}`,
    );
    return this.peers.save(peer);
  }

  /**
   * Enrols a node, or re-enrols it after a rebuild.
   *
   * A node that comes back with a new key keeps its address: the address is the
   * node's identity on the overlay, the key is only how it proves it. Changing
   * both at once would make every other peer's config wrong in two ways instead
   * of one.
   */
  async enrolMember(input: EnrolMemberInput): Promise<WireGuardPeerEntity> {
    this.assertPublicKey(input.publicKey);
    const existing = await this.peers.findOne({
      where: { nodeId: input.nodeId, revokedAt: IsNull() },
    });
    if (existing) {
      if (existing.publicKey !== input.publicKey) {
        this.logger.log(
          `[wg] node ${input.nodeId} presented a new key — keeping ${existing.managementIp}`,
        );
      }
      existing.publicKey = input.publicKey;
      if (input.endpointHost) existing.endpointHost = input.endpointHost;
      if (input.subnetId !== undefined) existing.subnetId = input.subnetId;
      return this.peers.save(existing);
    }

    const pool = await this.poolFor(input.subnetId);
    const taken = await this.allocatedAddresses();
    const peer = this.peers.create({
      clusterId: input.clusterId,
      nodeId: input.nodeId,
      role: WireGuardPeerRole.MEMBER,
      publicKey: input.publicKey,
      managementIp: pool.allocate(taken),
      endpointHost: input.endpointHost ?? null,
      subnetId: input.subnetId ?? null,
      // A mesh member listens; a management-overlay member does not. Recording
      // it here is what lets the renderer tell the two apart later.
      listenPort: input.subnetId ? WG_DEFAULT_PORT : null,
      status: WireGuardPeerStatus.PENDING,
    });
    this.logger.log(
      `[wg] node ${input.nodeId} enrolled at ${peer.managementIp}`,
    );
    return this.peers.save(peer);
  }

  /** Withdraws a peer. Its address stays claimed — see allocatedAddresses. */
  async revokeMember(nodeId: string): Promise<void> {
    const peer = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!peer) return;
    peer.status = WireGuardPeerStatus.REVOKED;
    peer.revokedAt = new Date();
    await this.peers.save(peer);
    this.logger.log(`[wg] node ${nodeId} revoked (was ${peer.managementIp})`);
  }

  async renderControlConfig(nodeId?: string): Promise<string | undefined> {
    return this.renderer.renderControlConfig(nodeId);
  }

  async renderMemberConfig(nodeId: string): Promise<string> {
    return this.renderer.renderMemberConfig(nodeId);
  }

  /**
   * The overlay as it applies to one cluster, for whoever is choosing an
   * address — or undefined when the overlay is off or cannot carry traffic yet.
   *
   * `enrolled` means a peer of this cluster has actually completed a handshake,
   * not merely that a row exists. A peer created a second ago is a row, and
   * routing telemetry at it would move a working flow onto a tunnel that has
   * never carried a packet. The legacy path stays until health is proven.
   */
  async overlayFor(
    clusterId: string,
  ): Promise<{ controlAddress: string; enrolled: boolean } | undefined> {
    if (!managementNetworkOn()) return undefined;
    const control = await this.controlPeer();
    if (!control) return undefined;
    const live = await this.livePeers();
    const enrolled = live.some(
      (p) =>
        p.clusterId === clusterId &&
        p.role === WireGuardPeerRole.MEMBER &&
        p.status === WireGuardPeerStatus.ACTIVE,
    );
    return { controlAddress: control.managementIp, enrolled };
  }

  /**
   * The overlay as it applies to one node: its own address, and whether that
   * node has actually handshaken.
   *
   * Per node rather than per cluster, because the two consumers — the address
   * baked into a kubeconfig and the firewall rule that opens the way to it —
   * both reason about a single machine. Sharing one answer between them is what
   * keeps them from ever disagreeing.
   */
  async nodeOverlayFor(
    nodeId: string,
  ): Promise<{ nodeAddress: string; enrolled: boolean } | undefined> {
    if (!managementNetworkOn()) return undefined;
    const peer = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!peer) return undefined;
    return {
      nodeAddress: peer.managementIp,
      enrolled: peer.status === WireGuardPeerStatus.ACTIVE,
    };
  }

  async renderMeshConfig(nodeId: string): Promise<string> {
    return this.renderer.renderMeshConfig(nodeId);
  }

  /**
   * The config this node should be running, whichever kind of network it is on.
   *
   * The choice belongs here rather than in the reconciler: it follows from the
   * peer record, and a caller that decided for itself could push a
   * management-overlay config onto a node whose K3s is bound to the mesh —
   * taking the cluster's own network away from it.
   */
  async renderConfigFor(nodeId: string): Promise<string> {
    const peer = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!peer) {
      throw new BadRequestException(`Node ${nodeId} is not enrolled`);
    }
    return peer.subnetId
      ? this.renderMeshConfig(nodeId)
      : this.renderMemberConfig(nodeId);
  }

  controlHandshakeDetails(): ReturnType<
    WireGuardPeerRenderer['controlHandshakeDetails']
  > {
    if (!managementNetworkOn()) return Promise.resolve(undefined);
    return this.renderer.controlHandshakeDetails();
  }

  async bootstrapPeersFor(nodeId: string): Promise<BootstrapPeer[]> {
    return this.renderer.bootstrapPeersFor(nodeId);
  }

  /** Records a handshake reading and says whether the peer just went quiet or came back. */
  async markHandshake(
    publicKey: string,
    at: Date | undefined,
  ): Promise<HandshakeTransition | null> {
    const peer = await this.peers.findOne({
      where: { publicKey, revokedAt: IsNull() },
    });
    if (peer?.role !== WireGuardPeerRole.MEMBER) return null;
    const before = peer.status;
    peer.lastHandshakeAt = at ?? peer.lastHandshakeAt ?? null;
    if (at) {
      peer.status = WireGuardPeerStatus.ACTIVE;
    } else if (peer.status === WireGuardPeerStatus.ACTIVE) {
      peer.status = WireGuardPeerStatus.STALE;
    }
    await this.peers.update(
      { id: peer.id },
      { status: peer.status, lastHandshakeAt: peer.lastHandshakeAt },
    );
    if (
      before === WireGuardPeerStatus.ACTIVE &&
      peer.status === WireGuardPeerStatus.STALE
    )
      return { kind: 'went-quiet', peer };
    if (
      before === WireGuardPeerStatus.STALE &&
      peer.status === WireGuardPeerStatus.ACTIVE
    )
      return { kind: 'came-back', peer };
    return null;
  }

  private assertPublicKey(value: string): void {
    if (!isWireGuardPublicKey(value)) {
      throw new BadRequestException(
        `Not a WireGuard public key: "${String(value).slice(0, 16)}…". ` +
          `A shell error captured as output must never be stored as a peer key.`,
      );
    }
  }
}

export { controlEndpoint, controlEndpointName } from './wireguard-peer-render';
