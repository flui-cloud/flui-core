import { WireGuardPeerService } from './wireguard-peer.service';
import { WireGuardPeerStatus } from '../entities/wireguard-peer.entity';

const KEY_MASTER = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_WORKER = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';
const KEY_MEMBER = 'hNBBm3jY4mCMeymQ4EaLuT3SEJPUrblbgnwJAJhK8Fo=';

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
    this.plainUpdates.push(patch);
    for (const row of this.rows.filter((r) => this.matches(r, where))) {
      Object.assign(row, patch);
    }
  };
  plainUpdates: any[] = [];
  merges: Array<{ set: any; wheres: string[]; params: any }> = [];
  createQueryBuilder = () => {
    const q = { set: {} as any, wheres: [] as string[], params: {} as any };
    const where = (clause: string, params: any = {}) => {
      q.wheres.push(clause);
      Object.assign(q.params, params);
      return chain;
    };
    const chain: any = {
      update: () => chain,
      set: (set: any) => ((q.set = set), chain),
      where,
      andWhere: where,
      setParameter: (k: string, v: any) => ((q.params[k] = v), chain),
      execute: async () => {
        this.merges.push(q);
        const patch = JSON.parse(q.params.patch);
        for (const row of this.rows) {
          if (row.publicKey !== q.params.publicKey) continue;
          if (row.role !== q.params.role || row.revokedAt != null) continue;
          row.controlHandshakes = {
            ...(row.controlHandshakes ?? {}),
            ...patch,
          };
        }
      },
    };
    return chain;
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

describe('which control nodes reach a member', () => {
  let peers: FakePeers;
  let svc: WireGuardPeerService;

  beforeEach(() => {
    delete process.env.FLUI_WG_POOL;
    peers = new FakePeers();
    svc = new WireGuardPeerService(
      peers as any,
      { find: async () => [] } as any,
    );
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
  const member = () =>
    svc.enrolMember({
      clusterId: 'wl',
      nodeId: 'wl-1',
      publicKey: KEY_MEMBER,
      endpointHost: '9.9.9.9',
    });

  it('lists every control node whose end is up until each has seen it', async () => {
    const m = await master();
    const w = await worker();
    await svc.markControlEnd(m.id, true);
    await svc.markControlEnd(w.id, true);
    await member();

    expect(
      (await svc.controlsNotReaching('wl-1')).map((r) => r.nodeId),
    ).toEqual(['master', 'worker-1']);

    await svc.recordControlReadings(m.id, [
      { publicKey: KEY_MEMBER, fresh: true, at: new Date() },
    ]);
    expect(
      (await svc.controlsNotReaching('wl-1')).map((r) => r.nodeId),
    ).toEqual(['worker-1']);

    await svc.recordControlReadings(w.id, [
      { publicKey: KEY_MEMBER, fresh: true, at: new Date() },
    ]);
    expect(await svc.controlsNotReaching('wl-1')).toEqual([]);
  });

  it('does not wait on a control node whose end never came up', async () => {
    const m = await master();
    await worker();
    await svc.markControlEnd(m.id, true);
    await member();
    await svc.recordControlReadings(m.id, [
      { publicKey: KEY_MEMBER, fresh: true, at: new Date() },
    ]);

    expect(await svc.controlsNotReaching('wl-1')).toEqual([]);
  });

  it('does not count a stale reading', async () => {
    const m = await master();
    await svc.markControlEnd(m.id, true);
    await member();
    await svc.recordControlReadings(m.id, [
      { publicKey: KEY_MEMBER, fresh: false },
    ]);
    expect(await svc.controlsNotReaching('wl-1')).toHaveLength(1);
  });

  it('does not count a reading too old to say anything about now', async () => {
    const m = await master();
    await svc.markControlEnd(m.id, true);
    await member();
    await svc.recordControlReadings(m.id, [
      { publicKey: KEY_MEMBER, fresh: true, at: new Date() },
    ]);
    const row = peers.rows.find((r) => r.nodeId === 'wl-1');
    row.controlHandshakes[m.id].readAt = new Date(
      Date.now() - 31 * 60 * 1000,
    ).toISOString();
    expect(await svc.controlsNotReaching('wl-1')).toHaveLength(1);
  });

  it('merges each control node’s reading in the database, so concurrent writers keep each other’s', async () => {
    const m = await master();
    const w = await worker();
    await member();

    await Promise.all([
      svc.recordControlReadings(m.id, [
        { publicKey: KEY_MEMBER, fresh: true, at: new Date() },
      ]),
      svc.recordControlReadings(w.id, [
        { publicKey: KEY_MEMBER, fresh: false },
      ]),
      svc.markHandshake(KEY_MEMBER, new Date()),
    ]);

    const row = peers.rows.find((r) => r.nodeId === 'wl-1');
    expect(Object.keys(row.controlHandshakes).sort()).toEqual(
      [m.id, w.id].sort(),
    );
    for (const merge of peers.merges) {
      expect(merge.set.controlHandshakes()).toBe(
        `COALESCE("controlHandshakes", '{}'::jsonb) || CAST(:patch AS jsonb)`,
      );
      expect(merge.wheres).toEqual([
        '"publicKey" = :publicKey',
        '"role" = :role',
        '"revokedAt" IS NULL',
      ]);
      expect(Object.keys(JSON.parse(merge.params.patch))).toHaveLength(1);
    }
    expect(
      peers.merges.map((q) => Object.keys(JSON.parse(q.params.patch))[0]),
    ).toEqual([m.id, w.id]);
    expect(peers.plainUpdates).toEqual([
      { status: WireGuardPeerStatus.ACTIVE, lastHandshakeAt: expect.any(Date) },
    ]);
  });

  it('writes readings onto members only', async () => {
    const m = await master();
    const w = await worker();
    await svc.recordControlReadings(m.id, [
      { publicKey: KEY_WORKER, fresh: true, at: new Date() },
    ]);
    expect(w.controlHandshakes).toBeUndefined();
  });
});
