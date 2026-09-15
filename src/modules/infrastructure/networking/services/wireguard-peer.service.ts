import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
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
  controlInterface,
  meshInterface,
  isWireGuardPublicKey,
  memberInterface,
  renderWireGuardConfig,
  WG_DEFAULT_PORT,
} from '../wireguard-config';

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
@Injectable()
export class WireGuardPeerService {
  private readonly logger = new Logger(WireGuardPeerService.name);

  constructor(
    @InjectRepository(WireGuardPeerEntity)
    private readonly peers: Repository<WireGuardPeerEntity>,
    @InjectRepository(VNetEntity)
    private readonly vnets: Repository<VNetEntity>,
  ) {}

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
    const fluiNetwork = known.find(
      (v) => v.implementation === VNetImplementation.WIREGUARD,
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

  async controlPeer(): Promise<WireGuardPeerEntity | null> {
    return this.peers.findOne({
      where: { role: WireGuardPeerRole.CONTROL, revokedAt: IsNull() },
    });
  }

  /**
   * Records the control cluster's own end of the overlay.
   *
   * Takes the first address in the pool, which is convention rather than
   * necessity: every member's config names it explicitly, so nothing breaks if
   * it is something else — it just stops being guessable while reading a
   * config over someone's shoulder.
   */
  async ensureControlPeer(params: {
    clusterId: string;
    publicKey: string;
    endpointHost: string;
    listenPort?: number;
  }): Promise<WireGuardPeerEntity> {
    this.assertPublicKey(params.publicKey);
    const existing = await this.controlPeer();
    if (existing) {
      existing.publicKey = params.publicKey;
      existing.endpointHost = params.endpointHost;
      existing.listenPort = params.listenPort ?? WG_DEFAULT_PORT;
      return this.peers.save(existing);
    }
    const pool = await this.pool();
    const taken = await this.allocatedAddresses();
    return this.peers.save(
      this.peers.create({
        clusterId: params.clusterId,
        nodeId: null,
        role: WireGuardPeerRole.CONTROL,
        publicKey: params.publicKey,
        managementIp: pool.allocate(taken),
        endpointHost: params.endpointHost,
        listenPort: params.listenPort ?? WG_DEFAULT_PORT,
        status: WireGuardPeerStatus.PENDING,
      }),
    );
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

  /**
   * The control cluster's config: every live member, one `/32` each.
   */
  async renderControlConfig(): Promise<string | undefined> {
    const control = await this.controlPeer();
    if (!control) return undefined;
    const members = (await this.livePeers()).filter(
      // A reservation without a key cannot be rendered as a peer: WireGuard
      // identifies peers by key, so a block without one is meaningless.
      (p) => p.role === WireGuardPeerRole.MEMBER && p.publicKey,
    );
    return renderWireGuardConfig(
      controlInterface({
        address: control.managementIp,
        listenPort: control.listenPort ?? WG_DEFAULT_PORT,
        members: members.map((m) => ({
          publicKey: m.publicKey as string,
          address: m.managementIp,
          label: `node ${m.nodeId}`,
        })),
      }),
    );
  }

  /**
   * A member's config: one peer, the control cluster.
   *
   * Refuses rather than guesses when the control end is not recorded or has no
   * reachable address — a config naming a peer that cannot be dialled is worse
   * than no config, because the interface comes up and looks healthy.
   */
  async renderMemberConfig(nodeId: string): Promise<string> {
    const peer = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!peer) {
      throw new BadRequestException(`Node ${nodeId} is not enrolled`);
    }
    const control = await this.controlPeer();
    if (!control) {
      throw new BadRequestException(
        'The control cluster has no WireGuard peer yet — enrol it first',
      );
    }
    if (!control.endpointHost) {
      throw new BadRequestException(
        'The control peer has no reachable endpoint recorded',
      );
    }
    if (!control.publicKey) {
      throw new BadRequestException(
        'The control peer has no key yet — its address is only reserved',
      );
    }
    return renderWireGuardConfig(
      memberInterface({
        address: peer.managementIp,
        control: {
          publicKey: control.publicKey,
          address: control.managementIp,
          endpoint: `${control.endpointHost}:${control.listenPort ?? WG_DEFAULT_PORT}`,
        },
      }),
    );
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
    if (process.env.FLUI_WG_ENABLED !== 'true') return undefined;
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
    if (process.env.FLUI_WG_ENABLED !== 'true') return undefined;
    const peer = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!peer) return undefined;
    return {
      nodeAddress: peer.managementIp,
      enrolled: peer.status === WireGuardPeerStatus.ACTIVE,
    };
  }

  /**
   * A node's config inside a Flui-managed subnet: a direct peer for each other
   * node of that subnet, and for nobody else.
   *
   * Unlike the management overlay, there is no hub here. Node-to-node traffic
   * in a BYOS estate is pod traffic — today it crosses the internet as
   * unencrypted VXLAN — and routing it through the control cluster would make
   * that cluster a bandwidth bottleneck and a single point of failure for
   * traffic that has nothing to do with management.
   */
  async renderMeshConfig(nodeId: string): Promise<string> {
    const self = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!self) {
      throw new BadRequestException(`Node ${nodeId} is not enrolled`);
    }
    if (!self.subnetId) {
      throw new BadRequestException(
        `Node ${nodeId} is not in a Flui-managed subnet — there is no mesh to render`,
      );
    }

    const live = await this.livePeers();
    const control = await this.controlPeer();
    return renderWireGuardConfig(
      meshInterface({
        self: {
          publicKey: self.publicKey ?? '',
          address: self.managementIp,
          subnetId: self.subnetId,
        },
        members: live
          .filter((p) => p.role === WireGuardPeerRole.MEMBER && p.publicKey)
          .map((p) => ({
            publicKey: p.publicKey as string,
            address: p.managementIp,
            endpoint: p.endpointHost
              ? `${p.endpointHost}:${p.listenPort ?? WG_DEFAULT_PORT}`
              : undefined,
            subnetId: p.subnetId ?? null,
            label: `node ${p.nodeId}`,
          })),
        // Omitted rather than refused when the control end is not ready: the
        // mesh is what carries this cluster's own traffic, and it should come
        // up even on an installation where management still runs the old way.
        control:
          control?.publicKey && control.endpointHost
            ? {
                publicKey: control.publicKey,
                address: control.managementIp,
                endpoint: `${control.endpointHost}:${control.listenPort ?? WG_DEFAULT_PORT}`,
              }
            : undefined,
        listenPort: self.listenPort ?? WG_DEFAULT_PORT,
      }),
    );
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

  /**
   * What a node needs baked into its cloud-init to raise the tunnel by itself.
   *
   * Undefined until the control peer has a key and an endpoint: handing a node
   * a half-filled config would leave it with an interface that comes up and
   * carries nothing, which reads as healthy and is worse than no tunnel.
   */
  async controlHandshakeDetails(): Promise<
    { publicKey: string; address: string; endpoint: string } | undefined
  > {
    if (process.env.FLUI_WG_ENABLED !== 'true') return undefined;
    const control = await this.controlPeer();
    if (!control?.publicKey || !control.endpointHost) return undefined;
    return {
      publicKey: control.publicKey,
      address: control.managementIp,
      endpoint: `${control.endpointHost}:${control.listenPort ?? WG_DEFAULT_PORT}`,
    };
  }

  /**
   * The siblings a node should already know about when it first boots.
   *
   * Only same-subnet peers that can actually be dialled: a node in another
   * subnet must not appear at all — that is where the isolation comes from —
   * and one with no key or no transport address would produce a config block
   * that looks complete and connects to nothing.
   */
  async bootstrapPeersFor(nodeId: string): Promise<BootstrapPeer[]> {
    const self = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!self?.subnetId) return [];
    return (await this.livePeers())
      .filter(
        (p) =>
          p.role === WireGuardPeerRole.MEMBER &&
          p.nodeId !== nodeId &&
          p.subnetId === self.subnetId &&
          !!p.publicKey &&
          !!p.endpointHost,
      )
      .map((p) => ({
        publicKey: p.publicKey as string,
        address: p.managementIp,
        endpoint: `${p.endpointHost}:${p.listenPort ?? WG_DEFAULT_PORT}`,
      }));
  }

  /** Source addresses the control's firewall must admit on the WireGuard port. */
  async memberEgressIps(): Promise<string[]> {
    const members = (await this.livePeers()).filter(
      (p) => p.role === WireGuardPeerRole.MEMBER && p.endpointHost,
    );
    return [...new Set(members.map((m) => `${m.endpointHost}/32`))];
  }

  async markHandshake(publicKey: string, at: Date | undefined): Promise<void> {
    const peer = await this.peers.findOne({
      where: { publicKey, revokedAt: IsNull() },
    });
    if (!peer) return;
    peer.lastHandshakeAt = at ?? peer.lastHandshakeAt ?? null;
    peer.status = at
      ? WireGuardPeerStatus.ACTIVE
      : peer.status === WireGuardPeerStatus.ACTIVE
        ? WireGuardPeerStatus.STALE
        : peer.status;
    await this.peers.save(peer);
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
