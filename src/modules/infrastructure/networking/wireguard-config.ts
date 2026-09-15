import { BadRequestException } from '@nestjs/common';

/**
 * Not `wg0`, and not port 51820.
 *
 * k3s can run flannel over its own `wireguard-native` backend, which claims
 * both. Flui does not use that backend today — the bootstrap installs
 * `--flannel-backend=vxlan` — but reserving the defaults costs nothing now and
 * avoids a collision that would be maddening to diagnose later, with two
 * WireGuard interfaces on one host and no way to tell from a rule which is
 * which.
 */
export const WG_INTERFACE = 'flui0';
export const WG_DEFAULT_PORT = 51821;

/**
 * Replaced on the node with the contents of its own key file.
 *
 * The rendered config is built by the control cluster, stored, logged and
 * shipped over SSH; a private key must never be in it. The node generates its
 * keypair locally and only the public half is ever sent to Flui.
 */
export const PRIVATE_KEY_PLACEHOLDER = '__FLUI_WG_PRIVATE_KEY__';

/**
 * 1500 underlay minus 80 bytes, which is the IPv6-safe WireGuard overhead —
 * 60 would be enough over IPv4 alone. Deliberately conservative: the cost is a
 * few bytes per packet, whereas guessing too high produces a path that works
 * for small packets and hangs on large ones.
 */
export const WG_DEFAULT_MTU = 1420;

export const DEFAULT_KEEPALIVE_SECONDS = 25;

export interface WireGuardPeerSpec {
  publicKey: string;
  allowedIps: string[];
  endpoint?: string;
  persistentKeepalive?: number;
  /** Comment written above the peer block, for the operator reading the file. */
  label?: string;
}

export interface WireGuardInterfaceSpec {
  address: string;
  listenPort?: number;
  mtu?: number;
  peers: WireGuardPeerSpec[];
}

const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

/** A WireGuard public key is 32 bytes in base64. Anything else is a typo, a
 *  truncation, or a private key pasted by mistake — all worth refusing before
 *  the config reaches a host. */
export function isWireGuardPublicKey(value: string): boolean {
  return PUBLIC_KEY_RE.test(value.trim());
}

export function renderWireGuardConfig(spec: WireGuardInterfaceSpec): string {
  assertUniqueAllowedIps(spec.peers);

  const lines: string[] = [
    '# Flui-managed WireGuard interface — DO NOT EDIT (reconciled by Flui).',
    '[Interface]',
    `Address = ${spec.address}/32`,
    `PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`,
    `MTU = ${spec.mtu ?? WG_DEFAULT_MTU}`,
  ];
  if (spec.listenPort) lines.push(`ListenPort = ${spec.listenPort}`);

  for (const peer of spec.peers) {
    if (!isWireGuardPublicKey(peer.publicKey)) {
      throw new BadRequestException(
        `Not a WireGuard public key: "${peer.publicKey.slice(0, 12)}…"`,
      );
    }
    if (peer.allowedIps.length === 0) {
      throw new BadRequestException(
        'A peer with no AllowedIPs can never be routed to — refusing to render it',
      );
    }
    lines.push('');
    if (peer.label) lines.push(`# ${peer.label}`);
    lines.push('[Peer]');
    lines.push(`PublicKey = ${peer.publicKey.trim()}`);
    lines.push(`AllowedIPs = ${peer.allowedIps.join(', ')}`);
    if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`);
    if (peer.persistentKeepalive) {
      lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * The control cluster's side: it listens, and knows one `/32` per member.
 *
 * No `Endpoint` on the member peers — members dial out and hold the tunnel
 * open with a keepalive, so their transport address can change without the
 * control cluster being told. That is what makes a member behind NAT or on a
 * provider that reassigns addresses work without any inbound rule of its own.
 */
export function controlInterface(params: {
  address: string;
  listenPort?: number;
  mtu?: number;
  members: Array<{ publicKey: string; address: string; label?: string }>;
}): WireGuardInterfaceSpec {
  return {
    address: params.address,
    listenPort: params.listenPort ?? WG_DEFAULT_PORT,
    mtu: params.mtu,
    peers: params.members.map((m) => ({
      publicKey: m.publicKey,
      allowedIps: [`${m.address}/32`],
      label: m.label,
    })),
  };
}

/**
 * A member node's side: one peer, the control cluster, reached at its public
 * transport address and kept alive from this end.
 *
 * `AllowedIPs` is the control's single `/32` and nothing else. Widening it to
 * the pool would make this node route every other member's traffic through the
 * control cluster — the transit the design forbids.
 */
export function memberInterface(params: {
  address: string;
  mtu?: number;
  control: { publicKey: string; address: string; endpoint: string };
  keepaliveSeconds?: number;
}): WireGuardInterfaceSpec {
  return {
    address: params.address,
    mtu: params.mtu,
    peers: [
      {
        publicKey: params.control.publicKey,
        allowedIps: [`${params.control.address}/32`],
        endpoint: params.control.endpoint,
        persistentKeepalive:
          params.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS,
        label: 'Flui control cluster',
      },
    ],
  };
}

function assertUniqueAllowedIps(peers: WireGuardPeerSpec[]): void {
  const seen = new Map<string, number>();
  peers.forEach((peer, index) => {
    for (const ip of peer.allowedIps) {
      const previous = seen.get(ip);
      if (previous !== undefined) {
        // WireGuard does not reject this: it silently moves the route to
        // whichever peer was configured last, and the other one goes dark.
        throw new BadRequestException(
          `AllowedIPs ${ip} is claimed by two peers (#${previous + 1} and ` +
            `#${index + 1}). WireGuard would route it to the last one and ` +
            `blackhole the other.`,
        );
      }
      seen.set(ip, index);
    }
  });
}

export interface MeshMember {
  publicKey: string;
  address: string;
  /** Public transport address. A member with none cannot be dialled and is
   *  therefore not a peer anyone can reach — see `meshInterface`. */
  endpoint?: string;
  subnetId?: string | null;
  label?: string;
}

/**
 * One node's view of a Flui-managed subnet: a direct peer for every other node
 * in the same subnet, and for nobody else.
 *
 * A full mesh rather than a hub, because the alternative is routing node-to-node
 * traffic through the control cluster — which would make it a bandwidth
 * bottleneck, a latency tax on every packet, and a single point of failure for
 * traffic that has nothing to do with management. For the small estates this
 * serves, N peers per node is cheaper than any of that.
 *
 * Subnet isolation falls out of the topology instead of being enforced on top
 * of it: a node in another subnet is simply never written into this config, so
 * there is no rule to forget and no route to leak.
 */
export function meshInterface(params: {
  self: MeshMember;
  members: MeshMember[];
  /** The control cluster, which is a peer of every subnet and belongs to none.
   *  One interface per node carries both jobs — see the note below. */
  control?: { publicKey: string; address: string; endpoint: string };
  listenPort?: number;
  mtu?: number;
  keepaliveSeconds?: number;
}): WireGuardInterfaceSpec {
  const keepalive = params.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS;
  const sameSubnet = params.members.filter(
    (m) =>
      m.address !== params.self.address &&
      (m.subnetId ?? null) === (params.self.subnetId ?? null),
  );

  const peers: WireGuardPeerSpec[] = sameSubnet
    // A peer with no reachable transport address cannot be dialled. Writing it
    // anyway would produce a config that looks complete and silently never
    // connects to that node.
    .filter((m) => !!m.endpoint && !!m.publicKey)
    .map((m) => ({
      publicKey: m.publicKey,
      allowedIps: [`${m.address}/32`],
      endpoint: m.endpoint,
      // Both ends keep the path open: either may sit behind NAT, and in a mesh
      // there is no designated dialler to carry that responsibility.
      persistentKeepalive: keepalive,
      label: m.label,
    }));

  // The control cluster rides the same interface rather than a second one.
  // A node has one overlay address and one MTU story; splitting management
  // off onto `flui1` would double the tunnels, the firewall rules and the
  // ways a node can be half-connected, to separate two things that never
  // conflict — the peers are distinct keys with distinct `/32`s either way.
  if (params.control && params.control.address !== params.self.address) {
    peers.push({
      publicKey: params.control.publicKey,
      allowedIps: [`${params.control.address}/32`],
      endpoint: params.control.endpoint,
      persistentKeepalive: keepalive,
      label: 'Flui control cluster',
    });
  }

  return {
    address: params.self.address,
    // Every node listens here, unlike the management overlay where only the
    // control does: in a mesh either end may be the one that dials first.
    listenPort: params.listenPort ?? WG_DEFAULT_PORT,
    mtu: params.mtu,
    peers,
  };
}

export interface BootstrapPeer {
  publicKey: string;
  address: string;
  endpoint?: string;
}

/**
 * The siblings a node should already know about when it first boots, encoded
 * for cloud-init.
 *
 * `pubkey|address|endpoint`, records separated by `;`. Neither separator can
 * occur in a base64 key, an IPv4 address or a `host:port`, so nothing has to be
 * quoted or escaped on the way through a shell — which is the whole reason for
 * choosing them.
 *
 * This is a head start, not the source of truth: a node added later is written
 * into the file by the reconciler. What it buys is a node that can reach its
 * own cluster the moment it boots, rather than after a reconcile cycle.
 */
export function encodeBootstrapPeers(peers: BootstrapPeer[]): string {
  return peers
    .filter((p) => isWireGuardPublicKey(p.publicKey) && !!p.address)
    .map((p) =>
      [p.publicKey.trim(), p.address, p.endpoint].filter(Boolean).join('|'),
    )
    .join(';');
}
