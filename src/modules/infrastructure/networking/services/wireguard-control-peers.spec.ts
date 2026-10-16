import { WireGuardPeerService } from './wireguard-peer.service';
import {
  WireGuardPeerRole,
  WireGuardPeerStatus,
} from '../entities/wireguard-peer.entity';

const KEY_MASTER = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_WORKER = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';
const KEY_MEMBER = 'hNBBm3jY4mCMeymQ4EaLuT3SEJPUrblbgnwJAJhK8Fo=';
const KEY_MEMBER_2 = 'AvBhnd7fb29eBhWasocwevAQqcGRZI73vxFfmQuQQHk=';

class FakePeers {
  rows: any[] = [];
  create = (x: any) => ({ ...x });
  save = async (x: any) => {
    if (!x.id) {
      x.id = `p${this.rows.length + 1}`;
      x.createdAt = new Date(Date.now() + this.rows.length);
      this.rows.push(x);
    }
    return x;
  };
  find = async ({ where }: any = {}) =>
    this.rows.filter((r) => this.matches(r, where));
  findOne = async ({ where }: any) =>
    this.rows.find((r) => this.matches(r, where)) ?? null;
  update = async (where: any, patch: any) => {
    for (const row of this.rows.filter((r) => this.matches(r, where))) {
      Object.assign(row, patch);
    }
  };
  private matches(row: any, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
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

describe('every control node is a peer of its own', () => {
  let peers: FakePeers;
  let svc: WireGuardPeerService;

  beforeEach(() => {
    delete process.env.FLUI_WG_POOL;
    delete process.env.FLUI_WG_ENDPOINT_NAME;
    process.env.FLUI_WG_ENABLED = 'true';
    peers = new FakePeers();
    svc = new WireGuardPeerService(
      peers as any,
      { find: async () => [] } as any,
    );
  });
  afterEach(() => {
    process.env.FLUI_WG_ENABLED = 'false';
    delete process.env.FLUI_WG_ENDPOINT_NAME;
  });

  const master = () =>
    svc.ensureControlPeer({
      clusterId: 'ctl',
      nodeId: 'master',
      primary: true,
      publicKey: KEY_MASTER,
      endpointHost: '1.1.1.1',
    });
  const worker = () =>
    svc.ensureControlPeer({
      clusterId: 'ctl',
      nodeId: 'worker-1',
      publicKey: KEY_WORKER,
      endpointHost: '2.2.2.2',
    });
  const member = (nodeId = 'wl-1', publicKey = KEY_MEMBER) =>
    svc.enrolMember({
      clusterId: 'wl',
      nodeId,
      publicKey,
      endpointHost: '9.9.9.9',
    });

  describe('rows', () => {
    it('gives the master the primary row and the first address', async () => {
      const row = await master();
      expect(row).toMatchObject({
        role: WireGuardPeerRole.CONTROL,
        nodeId: 'master',
        isPrimary: true,
        managementIp: '10.250.0.1',
        listenPort: 51821,
      });
    });

    it('gives a control worker a row of its own, with its own address and no primary flag', async () => {
      await master();
      const row = await worker();
      expect(row).toMatchObject({
        role: WireGuardPeerRole.CONTROL,
        nodeId: 'worker-1',
        isPrimary: false,
        managementIp: '10.250.0.2',
      });
      expect((await svc.controlPeer())?.nodeId).toBe('master');
      expect((await svc.controlPeers()).map((r) => r.nodeId)).toEqual([
        'master',
        'worker-1',
      ]);
    });

    it('is idempotent per node', async () => {
      await master();
      const first = await worker();
      const again = await worker();
      expect(again.id).toBe(first.id);
      expect(
        peers.rows.filter((r) => r.role === WireGuardPeerRole.CONTROL),
      ).toHaveLength(2);
    });

    it('fills the node of the row written before control nodes had one, keeping its address', async () => {
      peers.rows.push({
        id: 'legacy',
        clusterId: 'ctl',
        nodeId: null,
        role: WireGuardPeerRole.CONTROL,
        publicKey: KEY_MASTER,
        managementIp: '10.250.0.1',
        createdAt: new Date(0),
      });
      const row = await master();
      expect(row.id).toBe('legacy');
      expect(row).toMatchObject({
        nodeId: 'master',
        isPrimary: true,
        managementIp: '10.250.0.1',
      });
    });

    it('turns a control worker’s member reservation into its control row, keeping the address it may already carry', async () => {
      await master();
      const reserved = await svc.reserveAddress({
        clusterId: 'ctl',
        nodeId: 'worker-1',
      });
      const row = await worker();
      expect(row.id).toBe(reserved.id);
      expect(row.role).toBe(WireGuardPeerRole.CONTROL);
      expect(row.managementIp).toBe(reserved.managementIp);
    });

    it('moves the primary onto a rebuilt master, keeping its address, and drops the new master’s member reservation', async () => {
      const old = await master();
      const reservation = await svc.reserveAddress({
        clusterId: 'ctl-2',
        nodeId: 'master-2',
      });
      const moved = await svc.ensureControlPeer({
        clusterId: 'ctl-2',
        nodeId: 'master-2',
        primary: true,
        publicKey: KEY_MASTER,
        endpointHost: '5.5.5.5',
      });
      expect(moved.id).toBe(old.id);
      expect(moved).toMatchObject({
        clusterId: 'ctl-2',
        nodeId: 'master-2',
        managementIp: '10.250.0.1',
      });
      expect(reservation.revokedAt).toBeInstanceOf(Date);
    });

    it('withdraws the rows of control nodes that left, never the primary', async () => {
      await master();
      await worker();
      const gone = await svc.revokeDepartedControlPeers('ctl', ['master']);
      expect(gone.map((r) => r.nodeId)).toEqual(['worker-1']);
      expect((await svc.controlPeers()).map((r) => r.nodeId)).toEqual([
        'master',
      ]);
      await svc.revokeDepartedControlPeers('another-cluster', []);
      expect((await svc.controlPeer())?.nodeId).toBe('master');
    });

    it('withdraws the workers of a control cluster that was replaced', async () => {
      await master();
      await worker();
      await svc.ensureControlPeer({
        clusterId: 'ctl-2',
        nodeId: 'master-2',
        primary: true,
        publicKey: KEY_MASTER,
        endpointHost: '5.5.5.5',
      });
      const gone = await svc.revokeDepartedControlPeers('ctl-2', ['master-2']);
      expect(gone.map((r) => r.nodeId)).toEqual(['worker-1']);
    });
  });

  describe('configs', () => {
    it('lets each control node listen and carry every member, and no other control node', async () => {
      await master();
      const w = await worker();
      await member('wl-1', KEY_MEMBER);
      await member('wl-2', KEY_MEMBER_2);

      const cfg = (await svc.renderControlConfig('worker-1')) as string;

      expect(cfg).toContain(`Address = ${w.managementIp}/32`);
      expect(cfg).toContain('ListenPort = 51821');
      expect(cfg).toContain(`PublicKey = ${KEY_MEMBER}`);
      expect(cfg).toContain(`PublicKey = ${KEY_MEMBER_2}`);
      expect(cfg).not.toContain(KEY_MASTER);
      expect(cfg).not.toContain('Endpoint');
    });

    it('renders the primary when no node is named', async () => {
      await master();
      await worker();
      const cfg = (await svc.renderControlConfig()) as string;
      expect(cfg).toContain('Address = 10.250.0.1/32');
    });

    it('gives a member one peer per control node, each at its own address', async () => {
      await master();
      await worker();
      await member();

      const cfg = await svc.renderMemberConfig('wl-1');

      expect(cfg.match(/\[Peer\]/g)).toHaveLength(2);
      expect(cfg).toContain('AllowedIPs = 10.250.0.1/32');
      expect(cfg).toContain('Endpoint = 1.1.1.1:51821');
      expect(cfg).toContain('AllowedIPs = 10.250.0.2/32');
      expect(cfg).toContain('Endpoint = 2.2.2.2:51821');
      expect(cfg.match(/PersistentKeepalive = 25/g)).toHaveLength(2);
      expect(cfg).not.toContain('ListenPort');
    });

    it('dials only the primary by the declared name; a worker always by its address', async () => {
      process.env.FLUI_WG_ENDPOINT_NAME = 'wg.example.org';
      await master();
      await worker();
      await member();

      const cfg = await svc.renderMemberConfig('wl-1');

      expect(cfg).toContain('Endpoint = wg.example.org:51821');
      expect(cfg).toContain('Endpoint = 2.2.2.2:51821');
    });

    it('leaves out a control node that has no key yet rather than refusing', async () => {
      await master();
      peers.rows.push({
        id: 'reserved',
        clusterId: 'ctl',
        nodeId: 'worker-2',
        role: WireGuardPeerRole.CONTROL,
        isPrimary: false,
        publicKey: null,
        managementIp: '10.250.0.9',
        endpointHost: '3.3.3.3',
      });
      await member();

      const cfg = await svc.renderMemberConfig('wl-1');
      expect(cfg.match(/\[Peer\]/g)).toHaveLength(1);
      expect(cfg).not.toContain('10.250.0.9');
    });

    it('puts every control node into a mesh member’s config', async () => {
      await master();
      await worker();
      const meshSvc = new WireGuardPeerService(
        peers as any,
        {
          find: async () => [
            {
              id: 'v1',
              name: 'byos-net',
              provider: 'byos',
              ipRange: '10.200.0.0/16',
              implementation: 'wireguard',
              subnets: [{ id: 'sub-a', ipRange: '10.200.1.0/24' }],
            },
          ],
        } as any,
      );
      await meshSvc.enrolMember({
        clusterId: 'm',
        nodeId: 'm1',
        publicKey: KEY_MEMBER,
        subnetId: 'sub-a',
        endpointHost: '7.7.7.1',
      });

      const cfg = await meshSvc.renderMeshConfig('m1');
      expect(cfg).toContain('AllowedIPs = 10.250.0.1/32');
      expect(cfg).toContain('AllowedIPs = 10.250.0.2/32');
    });

    it('hands cloud-init the primary as the control and the others as peers', async () => {
      await master();
      await worker();
      await expect(svc.controlHandshakeDetails()).resolves.toEqual({
        publicKey: KEY_MASTER,
        address: '10.250.0.1',
        endpoint: '1.1.1.1:51821',
        others: [
          {
            publicKey: KEY_WORKER,
            address: '10.250.0.2',
            endpoint: '2.2.2.2:51821',
          },
        ],
      });
    });
  });

  describe('control rows are never treated as members', () => {
    it('does not let a control row’s health vouch for a cluster', async () => {
      const row = await master();
      await svc.markControlEnd(row.id, true);
      const overlay = await svc.overlayFor('ctl');
      expect(overlay).toEqual({
        controlAddress: '10.250.0.1',
        enrolled: false,
      });
    });

    it('keeps telemetry on the primary’s address', async () => {
      await master();
      await worker();
      expect((await svc.overlayFor('wl'))?.controlAddress).toBe('10.250.0.1');
    });

    it('records no member transition from a control row', async () => {
      await master();
      await expect(
        svc.markHandshake(KEY_MASTER, new Date()),
      ).resolves.toBeNull();
      expect((await svc.controlPeer())?.status).toBe(
        WireGuardPeerStatus.PENDING,
      );
    });

    it('reports a control node live once its end is up, which a direct link to it needs', async () => {
      await master();
      const w = await worker();
      expect((await svc.nodeOverlayFor('worker-1'))?.enrolled).toBe(false);
      await svc.markControlEnd(w.id, true);
      expect(await svc.nodeOverlayFor('worker-1')).toEqual({
        nodeAddress: w.managementIp,
        enrolled: true,
      });
      await svc.markControlEnd(w.id, false);
      expect((await svc.nodeOverlayFor('worker-1'))?.enrolled).toBe(false);
    });

    it('leaves a control row that never came up pending, not stale', async () => {
      const w = await (async () => {
        await master();
        return worker();
      })();
      await svc.markControlEnd(w.id, false);
      expect(w.status).toBe(WireGuardPeerStatus.PENDING);
    });
  });
});

describe('a temporary link between a control node and a member', () => {
  it('is not a second peer: they already peer through the hub', async () => {
    delete process.env.FLUI_WG_POOL;
    const peers = new FakePeers();
    const links = {
      find: jest.fn(async () => [
        {
          id: 'l1',
          purpose: 'db-replication',
          listenerNodeId: 'worker-1',
          dialerNodeId: 'wl-1',
          listenPort: 51821,
          state: 'open',
        },
      ]),
    };
    const svc = new WireGuardPeerService(
      peers as any,
      { find: async () => [] } as any,
      links as any,
    );
    await svc.ensureControlPeer({
      clusterId: 'ctl',
      nodeId: 'master',
      primary: true,
      publicKey: KEY_MASTER,
      endpointHost: '1.1.1.1',
    });
    await svc.ensureControlPeer({
      clusterId: 'ctl',
      nodeId: 'worker-1',
      publicKey: KEY_WORKER,
      endpointHost: '2.2.2.2',
    });
    await svc.enrolMember({
      clusterId: 'wl',
      nodeId: 'wl-1',
      publicKey: KEY_MEMBER,
      endpointHost: '9.9.9.9',
    });

    const control = (await svc.renderControlConfig('worker-1')) as string;
    const memberCfg = await svc.renderMemberConfig('wl-1');

    expect(control.match(/AllowedIPs = 10\.250\.0\.3\/32/g)).toHaveLength(1);
    expect(memberCfg.match(/AllowedIPs = 10\.250\.0\.2\/32/g)).toHaveLength(1);
  });
});
