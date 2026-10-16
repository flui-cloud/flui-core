import { BadRequestException } from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import {
  WireGuardLinkEntity,
  WireGuardLinkState,
} from '../entities/wireguard-link.entity';
import {
  WireGuardPeerEntity,
  WireGuardPeerRole,
} from '../entities/wireguard-peer.entity';
import {
  BootstrapPeer,
  ControlEnd,
  DEFAULT_KEEPALIVE_SECONDS,
  LinkPeer,
  WG_DEFAULT_PORT,
  WireGuardInterfaceSpec,
  controlInterface,
  memberInterface,
  meshInterface,
  renderWireGuardConfig,
  withLinks,
} from '../wireguard-config';
import { ControlPeerStore } from './wireguard-control-peers';

/**
 * Turns the peer table into the config each node should run. Reads only; what
 * is allocated and recorded is the peer service's business.
 */
export class WireGuardPeerRenderer {
  constructor(
    private readonly peers: Repository<WireGuardPeerEntity>,
    private readonly controls: ControlPeerStore,
    private readonly links?: Repository<WireGuardLinkEntity>,
  ) {}

  /**
   * One control node's config: every live member, one `/32` each. Without a
   * node, the primary's — what a caller from before per-node control peers
   * means.
   */
  async renderControlConfig(nodeId?: string): Promise<string | undefined> {
    const control = nodeId
      ? await this.controls.byNode(nodeId)
      : await this.controls.primary();
    if (!control) return undefined;
    const members = (await this.livePeers()).filter(
      // A reservation without a key cannot be rendered as a peer: WireGuard
      // identifies peers by key, so a block without one is meaningless.
      (p) => p.role === WireGuardPeerRole.MEMBER && p.publicKey,
    );
    return renderWireGuardConfig(
      await this.withLinksOf(
        control,
        controlInterface({
          address: control.managementIp,
          listenPort: control.listenPort ?? WG_DEFAULT_PORT,
          members: members.map((m) => ({
            publicKey: m.publicKey as string,
            address: m.managementIp,
            label: `node ${m.nodeId}`,
          })),
        }),
      ),
    );
  }

  /**
   * A member's config: one peer per control node.
   *
   * Refuses rather than guesses when the primary end is not recorded or has no
   * reachable address — a config naming a peer that cannot be dialled is worse
   * than no config, because the interface comes up and looks healthy. Another
   * control node that is not ready yet is left out and joins on a later pass.
   */
  async renderMemberConfig(nodeId: string): Promise<string> {
    const peer = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (!peer) {
      throw new BadRequestException(`Node ${nodeId} is not enrolled`);
    }
    const controls = await this.controls.all();
    const primary = controls[0];
    if (!primary) {
      throw new BadRequestException(
        'The control cluster has no WireGuard peer yet — enrol it first',
      );
    }
    if (!primary.endpointHost) {
      throw new BadRequestException(
        'The control peer has no reachable endpoint recorded',
      );
    }
    if (!primary.publicKey) {
      throw new BadRequestException(
        'The control peer has no key yet — its address is only reserved',
      );
    }
    return renderWireGuardConfig(
      await this.withLinksOf(
        peer,
        memberInterface({
          address: peer.managementIp,
          controls: controlEnds(controls),
        }),
      ),
    );
  }

  /**
   * A node's config inside a Flui-managed subnet: a direct peer for each other
   * node of that subnet, every control node, and nobody else.
   *
   * Unlike the management overlay, there is no hub here. Node-to-node traffic
   * in a BYOS estate is pod traffic, and routing it through the control
   * cluster would make that cluster a bandwidth bottleneck and a single point
   * of failure for traffic that has nothing to do with management.
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
    const mesh = meshInterface({
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
      // Only the control nodes that are ready: the mesh carries this cluster's
      // own traffic and must come up even where management still runs the old
      // way.
      controls: controlEnds(await this.controls.all()),
      listenPort: self.listenPort ?? WG_DEFAULT_PORT,
    });
    return renderWireGuardConfig(await this.withLinksOf(self, mesh));
  }

  /**
   * What a node needs baked into its cloud-init to raise the tunnel by itself:
   * the primary as the control, every other ready control node as a peer the
   * bootstrap already appends (`FLUI_WG_PEERS`), so nothing on the node has to
   * know there is more than one.
   */
  async controlHandshakeDetails(): Promise<
    | {
        publicKey: string;
        address: string;
        endpoint: string;
        others: BootstrapPeer[];
      }
    | undefined
  > {
    const [primary, ...rest] = await this.controls.all();
    if (!primary?.publicKey || !primary.endpointHost) return undefined;
    return {
      publicKey: primary.publicKey,
      address: primary.managementIp,
      endpoint: controlEndpoint(primary),
      others: controlEnds(rest).map((c) => ({
        publicKey: c.publicKey,
        address: c.address,
        endpoint: c.endpoint,
      })),
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

  /**
   * The open temporary links this node is one end of, as peers.
   *
   * Skipped rather than refused: a link whose other end has no key or no
   * address yet, and one between two nodes that already peer — in the same
   * subnet, or a control node and a member — where a second `/32` entry would
   * make the render throw and take the node's whole overlay down with it. Two
   * links joining the same pair of nodes are one peer.
   */
  private async withLinksOf(
    self: WireGuardPeerEntity,
    spec: WireGuardInterfaceSpec,
  ): Promise<WireGuardInterfaceSpec> {
    if (!this.links || !self.nodeId) return spec;
    const open = await this.links.find({
      where: [
        { state: WireGuardLinkState.OPEN, listenerNodeId: self.nodeId },
        { state: WireGuardLinkState.OPEN, dialerNodeId: self.nodeId },
      ],
    });
    if (!open.length) return spec;

    const live = await this.livePeers();
    const byNode = new Map(
      live.filter((p) => p.nodeId).map((p) => [p.nodeId as string, p]),
    );
    const { peers, listenPort } = linkPeersOf(self, open, byNode);
    return withLinks(spec, peers, listenPort);
  }

  private livePeers(): Promise<WireGuardPeerEntity[]> {
    return this.peers.find({ where: { revokedAt: IsNull() } });
  }
}

/** The control nodes a member can dial: keyed, with an address, primary first. */
export function controlEnds(rows: WireGuardPeerEntity[]): ControlEnd[] {
  return rows
    .filter((r) => !!r.publicKey && !!r.endpointHost)
    .map((r) => ({
      publicKey: r.publicKey as string,
      address: r.managementIp,
      endpoint: controlEndpoint(r),
      label:
        r.isPrimary || !r.nodeId
          ? 'Flui control cluster'
          : `Flui control node ${r.nodeId}`,
    }));
}

/**
 * Where members dial a control node: for the primary, its name when the
 * installation declared one, so a master rebuilt on another address is found
 * again once DNS follows; its address otherwise, and always for the others,
 * which no name spells.
 */
export function controlEndpoint(
  control: {
    endpointHost?: string | null;
    listenPort?: number | null;
    isPrimary?: boolean;
    nodeId?: string | null;
  },
  env = process.env,
): string {
  const primary = control.isPrimary === true || !control.nodeId;
  const host =
    (primary ? controlEndpointName(env) : undefined) ?? control.endpointHost;
  return `${host}:${control.listenPort ?? WG_DEFAULT_PORT}`;
}

/**
 * A name declared for the control master alone: members dial only the primary
 * by it, so it must not also lead to another control node. The hub checks it
 * on every pass and warns when it does not.
 */
export function controlEndpointName(env = process.env): string | undefined {
  // Only a declared name: the API's own name is published for every node that
  // takes traffic, and the primary listens on one of them.
  return env.FLUI_WG_ENDPOINT_NAME?.trim() || undefined;
}

function alreadyPeers(
  self: WireGuardPeerEntity,
  other: WireGuardPeerEntity,
): boolean {
  if (self.subnetId && other.subnetId === self.subnetId) return true;
  return (
    (self.role === WireGuardPeerRole.CONTROL) !==
    (other.role === WireGuardPeerRole.CONTROL)
  );
}

function linkPeersOf(
  self: WireGuardPeerEntity,
  open: WireGuardLinkEntity[],
  byNode: Map<string, WireGuardPeerEntity>,
): { peers: LinkPeer[]; listenPort: number | undefined } {
  const peers: LinkPeer[] = [];
  let listenPort: number | undefined;
  for (const link of open) {
    const listening = link.listenerNodeId === self.nodeId;
    const other = byNode.get(
      listening ? link.dialerNodeId : link.listenerNodeId,
    );
    if (!other?.publicKey) continue;
    if (alreadyPeers(self, other)) continue;
    if (listening) listenPort = listenPort ?? link.listenPort;
    if (peers.some((p) => p.publicKey === other.publicKey)) continue;
    const peer = linkPeerOf(link, other, listening);
    if (peer) peers.push(peer);
  }
  return { peers, listenPort };
}

function linkPeerOf(
  link: WireGuardLinkEntity,
  other: WireGuardPeerEntity,
  listening: boolean,
): LinkPeer | null {
  if (listening) {
    return {
      publicKey: other.publicKey,
      address: other.managementIp,
      label: `link ${link.id} (${link.purpose}) from node ${other.nodeId}`,
    };
  }
  if (!other.endpointHost) return null;
  return {
    publicKey: other.publicKey,
    address: other.managementIp,
    endpoint: `${other.endpointHost}:${link.listenPort}`,
    keepaliveSeconds: DEFAULT_KEEPALIVE_SECONDS,
    label: `link ${link.id} (${link.purpose}) to node ${other.nodeId}`,
  };
}
