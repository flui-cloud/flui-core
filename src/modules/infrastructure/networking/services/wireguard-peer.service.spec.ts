import { BadRequestException } from '@nestjs/common';
import { WireGuardPeerService } from './wireguard-peer.service';
import {
  WireGuardPeerRole,
  WireGuardPeerStatus,
} from '../entities/wireguard-peer.entity';

const KEY_A = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_B = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';
const KEY_C = 'hNBBm3jY4mCMeymQ4EaLuT3SEJPUrblbgnwJAJhK8Fo=';

/** A minimal in-memory stand-in for the repository, so allocation and desired
 *  state are exercised for real rather than through a wall of mocks. */
class FakePeers {
  rows: any[] = [];
  create = (x: any) => ({ ...x });
  save = async (x: any) => {
    if (!x.id) {
      x.id = `p${this.rows.length + 1}`;
      this.rows.push(x);
    }
    return x;
  };
  find = async ({ where }: any = {}) =>
    this.rows.filter((r) => this.matches(r, where));
  findOne = async ({ where }: any) =>
    this.rows.find((r) => this.matches(r, where)) ?? null;

  private matches(row: any, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      // revokedAt first: the value is TypeORM's IsNull() operator, and the
      // generic object guard below would otherwise skip the filter entirely.
      if (k === 'revokedAt') {
        if (row.revokedAt != null) return false;
        continue;
      }
      if (v && typeof v === 'object') continue;
      if (row[k] !== v) return false;
    }
    return true;
  }
}

describe('WireGuardPeerService', () => {
  let peers: FakePeers;
  let svc: WireGuardPeerService;

  const vnets = (ranges: string[] = []) => ({
    find: async () => ranges.map((ipRange) => ({ ipRange, subnets: [] })),
  });

  /** Two Flui-built subnets on one network. */
  const managedVnets = () => ({
    find: async () => [
      {
        id: 'v1',
        name: 'byos-net',
        provider: 'byos',
        ipRange: '10.200.0.0/16',
        implementation: 'wireguard',
        subnets: [
          { id: 'sub-a', ipRange: '10.200.1.0/24' },
          { id: 'sub-b', ipRange: '10.200.2.0/24' },
        ],
      },
    ],
  });

  beforeEach(() => {
    peers = new FakePeers();
    svc = new WireGuardPeerService(peers as any, vnets() as any);
    delete process.env.FLUI_WG_POOL;
  });

  const enrolControl = () =>
    svc.ensureControlPeer({
      clusterId: 'ctl',
      publicKey: KEY_A,
      endpointHost: '1.2.3.4',
    });

  describe('the pool respects networks that already exist', () => {
    it('refuses a pool overlapping a known VNet', async () => {
      process.env.FLUI_WG_POOL = '10.0.0.0/16';
      svc = new WireGuardPeerService(
        peers as any,
        vnets(['10.0.1.0/24']) as any,
      );
      await expect(svc.pool()).rejects.toThrow(/overlaps 10\.0\.1\.0\/24/);
    });

    it('is rebuilt per call, so a VNet created later still counts', async () => {
      // Cached at start-up, an overlap created afterwards would never be seen —
      // and noticing it before an address is handed out is the whole point.
      const changing = {
        calls: 0,
        async find() {
          this.calls++;
          return [];
        },
      };
      svc = new WireGuardPeerService(peers as any, changing as any);
      await svc.pool();
      await svc.pool();
      expect(changing.calls).toBe(2);
    });
  });

  describe('enrolment', () => {
    it('gives the control cluster the first address', async () => {
      const control = await enrolControl();
      expect(control.managementIp).toBe('10.250.0.1');
      expect(control.role).toBe(WireGuardPeerRole.CONTROL);
      expect(control.listenPort).toBe(51821);
    });

    it('gives each node the next free address', async () => {
      await enrolControl();
      const a = await svc.enrolMember({
        clusterId: 'w',
        nodeId: 'n1',
        publicKey: KEY_B,
      });
      expect(a.managementIp).toBe('10.250.0.2');
    });

    it('keeps a node’s address when it comes back with a new key', async () => {
      // The address is the node's identity on the overlay; the key is only how
      // it proves it. Changing both would make every peer config wrong twice.
      await enrolControl();
      const first = await svc.enrolMember({
        clusterId: 'w',
        nodeId: 'n1',
        publicKey: KEY_B,
      });
      const again = await svc.enrolMember({
        clusterId: 'w',
        nodeId: 'n1',
        publicKey: KEY_A,
      });
      expect(again.managementIp).toBe(first.managementIp);
      expect(again.publicKey).toBe(KEY_A);
    });

    it('refuses a key that is really a captured shell error', async () => {
      await expect(
        svc.enrolMember({
          clusterId: 'w',
          nodeId: 'n1',
          publicKey: 'wg: command not found',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not free a revoked address for the next enrolment', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await svc.revokeMember('n1');
      const next = await svc.enrolMember({
        clusterId: 'w',
        nodeId: 'n2',
        publicKey: KEY_B,
      });
      // n1 held .2; a rebuilt node must not inherit the identity of the one it
      // replaced while stale configs elsewhere may still name it.
      expect(next.managementIp).toBe('10.250.0.3');
    });
  });

  describe('rendering', () => {
    it('gives the control one peer block per live member', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      const cfg = await svc.renderControlConfig();
      expect(cfg).toContain('ListenPort = 51821');
      expect(cfg).toContain('AllowedIPs = 10.250.0.2/32');
    });

    it('drops a revoked member from the control config', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await svc.revokeMember('n1');
      expect(await svc.renderControlConfig()).not.toContain('10.250.0.2/32');
    });

    it('points a member at the control endpoint', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      const cfg = await svc.renderMemberConfig('n1');
      expect(cfg).toContain('Endpoint = 1.2.3.4:51821');
      expect(cfg).toContain('AllowedIPs = 10.250.0.1/32');
      expect(cfg).toContain('PersistentKeepalive = 25');
    });

    it('refuses to render a member config before the control is enrolled', async () => {
      // An interface that comes up against an undiallable peer looks healthy
      // and carries nothing — worse than having no config at all.
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await expect(svc.renderMemberConfig('n1')).rejects.toThrow(
        /control cluster has no WireGuard peer/,
      );
    });

    it('refuses to render for a node that was never enrolled', async () => {
      await enrolControl();
      await expect(svc.renderMemberConfig('ghost')).rejects.toThrow(
        /not enrolled/,
      );
    });
  });

  describe('handshake tracking', () => {
    it('marks a peer active when a handshake is seen', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await svc.markHandshake(KEY_B, new Date());
      const peer = await peers.findOne({ where: { nodeId: 'n1' } });
      expect(peer.status).toBe(WireGuardPeerStatus.ACTIVE);
    });

    it('moves an active peer to stale when the handshake disappears', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await svc.markHandshake(KEY_B, new Date());
      await svc.markHandshake(KEY_B, undefined);
      const peer = await peers.findOne({ where: { nodeId: 'n1' } });
      expect(peer.status).toBe(WireGuardPeerStatus.STALE);
    });

    it('leaves a peer that never handshook as pending, not stale', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await svc.markHandshake(KEY_B, undefined);
      const peer = await peers.findOne({ where: { nodeId: 'n1' } });
      expect(peer.status).toBe(WireGuardPeerStatus.PENDING);
    });
  });

  it('lists member egress addresses for the control firewall', async () => {
    await enrolControl();
    await svc.enrolMember({
      clusterId: 'w',
      nodeId: 'n1',
      publicKey: KEY_B,
      endpointHost: '5.6.7.8',
    });
    expect(await svc.memberEgressIps()).toEqual(['5.6.7.8/32']);
  });

  describe('overlayFor', () => {
    beforeEach(() => {
      process.env.FLUI_WG_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.FLUI_WG_ENABLED;
    });

    it('is undefined while the overlay is switched off', async () => {
      delete process.env.FLUI_WG_ENABLED;
      await enrolControl();
      await expect(svc.overlayFor('w')).resolves.toBeUndefined();
    });

    it('is undefined before the control cluster has a peer', async () => {
      await expect(svc.overlayFor('w')).resolves.toBeUndefined();
    });

    it('reports not-enrolled while the peer has never handshaken', async () => {
      // A row is not a tunnel. Callers use this to keep the legacy path until
      // the new one has actually carried a packet.
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await expect(svc.overlayFor('w')).resolves.toEqual({
        controlAddress: '10.250.0.1',
        enrolled: false,
      });
    });

    it('reports enrolled once a peer of that cluster is active', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await svc.markHandshake(KEY_B, new Date());
      await expect(svc.overlayFor('w')).resolves.toMatchObject({
        enrolled: true,
      });
    });

    it('does not let one cluster’s healthy peer vouch for another', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await svc.markHandshake(KEY_B, new Date());
      await expect(svc.overlayFor('other')).resolves.toMatchObject({
        enrolled: false,
      });
    });
  });

  describe('reserveAddress', () => {
    it('assigns an address to a node that does not exist yet', async () => {
      // The whole point: the address can go into the API server certificate at
      // first boot, so the cluster never needs its certificate regenerated.
      await enrolControl();
      const peer = await svc.reserveAddress({ clusterId: 'w', nodeId: 'n1' });
      expect(peer.managementIp).toBe('10.250.0.2');
      expect(peer.publicKey).toBeNull();
    });

    it('is idempotent — a second call returns the same address', async () => {
      await enrolControl();
      const first = await svc.reserveAddress({ clusterId: 'w', nodeId: 'n1' });
      const again = await svc.reserveAddress({ clusterId: 'w', nodeId: 'n1' });
      expect(again.managementIp).toBe(first.managementIp);
    });

    it('keeps the reserved address when the node finally reports its key', async () => {
      await enrolControl();
      const reserved = await svc.reserveAddress({
        clusterId: 'w',
        nodeId: 'n1',
      });
      const enrolled = await svc.enrolMember({
        clusterId: 'w',
        nodeId: 'n1',
        publicKey: KEY_B,
      });
      expect(enrolled.managementIp).toBe(reserved.managementIp);
      expect(enrolled.publicKey).toBe(KEY_B);
    });

    it('holds the address against other allocations while it waits', async () => {
      await enrolControl();
      await svc.reserveAddress({ clusterId: 'w', nodeId: 'n1' });
      const other = await svc.reserveAddress({ clusterId: 'w', nodeId: 'n2' });
      expect(other.managementIp).toBe('10.250.0.3');
    });

    it('is left out of the control config until it has a key', async () => {
      // WireGuard identifies peers by key: a block without one is meaningless.
      await enrolControl();
      await svc.reserveAddress({ clusterId: 'w', nodeId: 'n1' });
      const cfg = await svc.renderControlConfig();
      expect(cfg).not.toContain('10.250.0.2/32');
    });

    it('refuses to render a member config against a keyless control', async () => {
      const peers2 = new FakePeers();
      const svc2 = new WireGuardPeerService(peers2 as any, vnets() as any);
      await svc2.reserveAddress({ clusterId: 'w', nodeId: 'n1' });
      await expect(svc2.renderMemberConfig('n1')).rejects.toThrow(
        /no WireGuard peer|only reserved/,
      );
    });
  });

  describe('controlHandshakeDetails', () => {
    beforeEach(() => {
      process.env.FLUI_WG_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.FLUI_WG_ENABLED;
    });

    it('gives a node everything it needs to raise the tunnel unaided', async () => {
      await enrolControl();
      await expect(svc.controlHandshakeDetails()).resolves.toEqual({
        publicKey: KEY_A,
        address: '10.250.0.1',
        endpoint: '1.2.3.4:51821',
      });
    });

    it('is undefined while the control is only a reservation', async () => {
      // A half-filled config leaves the node with an interface that comes up
      // and carries nothing — which reads as healthy and is worse than none.
      await svc.reserveAddress({ clusterId: 'ctl', nodeId: 'n0' });
      await expect(svc.controlHandshakeDetails()).resolves.toBeUndefined();
    });

    it('is undefined while the overlay is off', async () => {
      delete process.env.FLUI_WG_ENABLED;
      await enrolControl();
      await expect(svc.controlHandshakeDetails()).resolves.toBeUndefined();
    });
  });

  describe('a Flui-managed subnet', () => {
    beforeEach(() => {
      svc = new WireGuardPeerService(peers as any, managedVnets() as any);
    });

    const inSubnet = (nodeId: string, publicKey: string, subnetId: string) =>
      svc.enrolMember({
        clusterId: 'byos',
        nodeId,
        publicKey,
        subnetId,
        endpointHost: `1.1.1.${nodeId.slice(-1)}`,
      });

    it('gives mesh members a listen port, unlike overlay members', async () => {
      // In a mesh either end may dial first; on the management overlay only the
      // control listens.
      await enrolControl();
      const mesh = await inSubnet('n1', KEY_B, 'sub-a');
      const overlay = await svc.enrolMember({
        clusterId: 'w',
        nodeId: 'n9',
        publicKey: KEY_A,
      });
      expect(mesh.listenPort).toBe(51821);
      expect(overlay.listenPort).toBeNull();
    });

    it('renders a peer for each other node of the same subnet', async () => {
      await inSubnet('n1', KEY_B, 'sub-a');
      await inSubnet('n2', KEY_A, 'sub-a');
      const cfg = await svc.renderMeshConfig('n1');
      expect(cfg).toContain('AllowedIPs = 10.200.1.2/32');
      expect(cfg).toContain('ListenPort = 51821');
    });

    it('never renders a node from another subnet', async () => {
      await inSubnet('n1', KEY_B, 'sub-a');
      await inSubnet('n2', KEY_A, 'sub-b');
      const cfg = await svc.renderMeshConfig('n1');
      expect(cfg).not.toContain('10.200.2.1/32');
    });

    it('refuses to render a mesh for a node that is not in one', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n1', publicKey: KEY_B });
      await expect(svc.renderMeshConfig('n1')).rejects.toThrow(
        /not in a Flui-managed subnet/,
      );
    });

    it('draws the address from the network the operator was shown', async () => {
      // Not from the flat management pool: the range in the VNet is what the
      // firewall rules name, so an address from anywhere else makes that CIDR
      // a lie.
      const peer = await inSubnet('n1', KEY_B, 'sub-a');
      expect(peer.managementIp).toBe('10.200.1.1');
    });

    it('keeps each subnet’s numbering to itself', async () => {
      const a = await inSubnet('n1', KEY_B, 'sub-a');
      const b = await inSubnet('n2', KEY_A, 'sub-b');
      expect(a.managementIp).toBe('10.200.1.1');
      expect(b.managementIp).toBe('10.200.2.1');
    });

    it('refuses to hand out addresses inside a provider-built network', async () => {
      // The provider already assigns those; a second allocator would give two
      // answers for where a node is.
      svc = new WireGuardPeerService(
        peers as any,
        {
          find: async () => [
            {
              id: 'v2',
              name: 'hetzner-net',
              provider: 'hetzner',
              ipRange: '10.10.0.0/16',
              implementation: 'provider-native',
              subnets: [{ id: 'sub-h', ipRange: '10.10.1.0/24' }],
            },
          ],
        } as any,
      );
      await expect(
        svc.reserveAddress({ clusterId: 'c', nodeId: 'n1', subnetId: 'sub-h' }),
      ).rejects.toThrow(/provider-native/);
    });

    it('refuses a subnet that does not exist rather than inventing a range', async () => {
      await expect(
        svc.reserveAddress({ clusterId: 'c', nodeId: 'n1', subnetId: 'ghost' }),
      ).rejects.toThrow(/does not exist/);
    });

    it('reserves a mesh address before the machine exists', async () => {
      const peer = await svc.reserveAddress({
        clusterId: 'byos',
        nodeId: 'n7',
        subnetId: 'sub-a',
      });
      expect(peer.managementIp).toBe('10.200.1.1');
      expect(peer.subnetId).toBe('sub-a');
      expect(peer.listenPort).toBe(51821);
    });

    it('gives a mesh node its mesh config, not the management one', async () => {
      // The reconciler must not choose: a management-overlay config pushed onto
      // a node whose K3s is bound to the mesh would take away the cluster's own
      // network.
      await enrolControl();
      await inSubnet('n1', KEY_B, 'sub-a');
      const cfg = await svc.renderConfigFor('n1');
      expect(cfg).toContain('ListenPort = 51821');
    });

    it('only calls a subnet Flui-managed when Flui built the network', async () => {
      expect(await svc.managedSubnetId('sub-a')).toBe('sub-a');
      expect(await svc.managedSubnetId('ghost')).toBeUndefined();
      expect(await svc.managedSubnetId(undefined)).toBeUndefined();
    });

    it('tells a new node about its siblings and nobody else', async () => {
      await inSubnet('n1', KEY_B, 'sub-a');
      await inSubnet('n2', KEY_A, 'sub-a');
      await inSubnet('n3', KEY_C, 'sub-b');

      const peers = await svc.bootstrapPeersFor('n1');

      expect(peers).toEqual([
        {
          publicKey: KEY_A,
          address: '10.200.1.2',
          endpoint: '1.1.1.2:51821',
        },
      ]);
    });

    it('leaves out a sibling that cannot be dialled', async () => {
      // A peer with no transport address produces a config block that looks
      // complete and connects to nothing.
      await inSubnet('n1', KEY_B, 'sub-a');
      await svc.enrolMember({
        clusterId: 'byos',
        nodeId: 'n2',
        publicKey: KEY_A,
        subnetId: 'sub-a',
      });
      expect(await svc.bootstrapPeersFor('n1')).toEqual([]);
    });

    it('has nothing to say about a node on the management overlay', async () => {
      await enrolControl();
      await svc.enrolMember({ clusterId: 'w', nodeId: 'n9', publicKey: KEY_A });
      expect(await svc.bootstrapPeersFor('n9')).toEqual([]);
    });

    it('keeps a node’s subnet when it re-enrols with a new key', async () => {
      await inSubnet('n1', KEY_B, 'sub-a');
      const again = await svc.enrolMember({
        clusterId: 'byos',
        nodeId: 'n1',
        publicKey: KEY_A,
        subnetId: 'sub-a',
      });
      expect(again.subnetId).toBe('sub-a');
    });
  });
});
