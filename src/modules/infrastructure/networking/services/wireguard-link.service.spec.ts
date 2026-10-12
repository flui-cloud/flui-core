import { WireGuardLinkService } from './wireguard-link.service';
import { WireGuardLinkState } from '../entities/wireguard-link.entity';
import { CrossProviderFirewallService } from '../../firewalls/services/cross-provider-firewall.service';

const KEY_A = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_B = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';

class FakeLinks {
  rows: any[] = [];
  create = (x: any) => ({ ...x });
  save = async (x: any) => {
    if (!x.id) {
      x.id = `l${this.rows.length + 1}`;
      this.rows.push(x);
    }
    return x;
  };
  find = async ({ where }: any) => this.rows.filter((r) => match(r, where));
  findOne = async ({ where }: any) =>
    this.rows.find((r) => match(r, where)) ?? null;
}

function match(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && '_type' in v) {
      if (v._type === 'not') return row[k] !== v._value;
      if (v._type === 'in') return v._value.includes(row[k]);
    }
    return row[k] === v;
  });
}

const peerA = {
  nodeId: 'a1',
  clusterId: 'src',
  publicKey: KEY_A,
  managementIp: '10.250.0.2',
  endpointHost: '9.9.9.9',
  listenPort: null,
};
const peerB = {
  nodeId: 'b1',
  clusterId: 'dst',
  publicKey: KEY_B,
  managementIp: '10.250.0.3',
  endpointHost: '8.8.8.8',
  listenPort: null,
};

function cluster(id: string, nodeId: string, ip: string) {
  return {
    id,
    provider: 'hetzner',
    nodes: [{ id: nodeId, ipAddress: ip, nodeType: 'master' }],
  };
}

function setup(opts: { live?: any[]; unreachable?: string[] } = {}) {
  const calls: string[] = [];
  const links = new FakeLinks();
  const live = opts.live ?? [peerA, peerB];
  const clusters = {
    findOne: jest.fn(async ({ where }: any) =>
      where.id === 'src'
        ? cluster('src', 'a1', '9.9.9.9')
        : cluster('dst', 'b1', '8.8.8.8'),
    ),
  };
  const kernel = new Map<string, string[]>([
    ['9.9.9.9', []],
    ['8.8.8.8', []],
  ]);
  const peerService = {
    livePeers: jest.fn(async () => live),
    renderConfigFor: jest.fn(async (nodeId: string) => `config ${nodeId}`),
  };
  const hostCommand = {
    apply: jest.fn(async (target: any) => {
      if (opts.unreachable?.includes(target.host))
        throw new Error('ssh: connect timed out');
      calls.push(`apply:${target.host}`);
      const open = links.rows.some((l) => l.state === WireGuardLinkState.OPEN);
      kernel.set(
        target.host,
        open ? [target.host === '9.9.9.9' ? KEY_B : KEY_A] : [],
      );
      return 'FLUI_WG_APPLIED';
    }),
  };
  const hub = {
    readState: jest.fn(async (target: any) => {
      if (opts.unreachable?.includes(target.host))
        throw new Error('ssh: connect timed out');
      return {
        interface: 'flui0',
        peers: (kernel.get(target.host) ?? []).map((publicKey) => ({
          publicKey,
          allowedIps: [],
          latestHandshakeAt: new Date(),
          transferRx: 0,
          transferTx: 0,
        })),
      };
    }),
  };
  const firewall = {
    admitLinks: jest.fn(async (clusterId: string) => {
      calls.push(`firewall:${clusterId}`);
    }),
  };
  const moduleRef = {
    get: (cls: unknown) =>
      cls === CrossProviderFirewallService ? firewall : undefined,
  };
  const svc = new WireGuardLinkService(
    links as any,
    clusters as any,
    peerService as any,
    hostCommand as any,
    hub as any,
    moduleRef as any,
  );
  return { svc, links, calls, firewall, hostCommand };
}

const openInput = {
  purpose: 'db-replication',
  ownerId: 'repl-1',
  listenerNodeId: 'a1',
  dialerNodeId: 'b1',
};

describe('WireGuardLinkService', () => {
  it('opens once per owner and converges firewall, listener, dialer in that order', async () => {
    const { svc, links, calls } = setup();
    const first = await svc.open(openInput);
    expect(calls).toEqual(['firewall:src', 'apply:9.9.9.9', 'apply:8.8.8.8']);
    const again = await svc.open(openInput);
    expect(again.id).toBe(first.id);
    expect(links.rows).toHaveLength(1);
    expect(first).toMatchObject({
      listenerClusterId: 'src',
      dialerClusterId: 'dst',
      listenPort: 51821,
      serviceTcpPort: 15432,
      dialerEgressIp: '8.8.8.8',
      state: WireGuardLinkState.OPEN,
    });
  });

  it('converges an existing open link again when it is reopened, so a resumed run repairs the hosts', async () => {
    const { svc, links, calls } = setup();
    await svc.open(openInput);
    calls.length = 0;
    await svc.open(openInput);
    expect(links.rows).toHaveLength(1);
    expect(calls).toEqual(['firewall:src', 'apply:9.9.9.9', 'apply:8.8.8.8']);
  });

  it('gives a second link on the same listener its own service port', async () => {
    const { svc } = setup();
    await svc.open(openInput);
    const second = await svc.open({ ...openInput, ownerId: 'repl-2' });
    expect(second.serviceTcpPort).toBe(15433);
  });

  it('refuses a node that has no key yet', async () => {
    const { svc } = setup({ live: [peerA, { ...peerB, publicKey: null }] });
    await expect(svc.open(openInput)).rejects.toThrow(/enrolled/);
  });

  it('waits for a fresh handshake seen from both ends', async () => {
    const { svc } = setup();
    const link = await svc.open(openInput);
    const after = await svc.awaitHandshake(link.id, { pollMs: 1 });
    expect(after.lastHandshakeAt).toBeInstanceOf(Date);
  });

  it('fails the handshake gate when one end never sees the other', async () => {
    const { svc } = setup();
    const link = await svc.open(openInput);
    (svc as any).hub.readState = jest.fn(async (t: any) => ({
      interface: 'flui0',
      peers:
        t.host === '9.9.9.9'
          ? [{ publicKey: KEY_B, allowedIps: [], transferRx: 0, transferTx: 0 }]
          : [
              {
                publicKey: KEY_A,
                allowedIps: [],
                latestHandshakeAt: new Date(),
                transferRx: 0,
                transferTx: 0,
              },
            ],
    }));
    await expect(
      svc.awaitHandshake(link.id, { timeoutMs: 5, pollMs: 1 }),
    ).rejects.toThrow(/listener did not/);
  });

  it('closes the firewall rule before touching any host, and marks it closed once both forget the other', async () => {
    const { svc, calls } = setup();
    const link = await svc.open(openInput);
    calls.length = 0;
    const closed = await svc.close(link.id);
    expect(calls[0]).toBe('firewall:src');
    expect(calls.slice(1)).toEqual(['apply:9.9.9.9', 'apply:8.8.8.8']);
    expect(closed.state).toBe(WireGuardLinkState.CLOSED);
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it('stays closing while a host cannot be reached, with the rule already gone', async () => {
    const ctx = setup();
    const link = await ctx.svc.open(openInput);
    const unreachable = setup({ unreachable: ['8.8.8.8'] });
    unreachable.links.rows = ctx.links.rows;
    unreachable.calls.length = 0;
    const after = await unreachable.svc.close(link.id);
    expect(unreachable.calls[0]).toBe('firewall:src');
    expect(after.state).toBe(WireGuardLinkState.CLOSING);
  });

  it('sweeps an open link whose node left the overlay', async () => {
    const ctx = setup();
    const link = await ctx.svc.open(openInput);
    const revoked = setup({ live: [peerA] });
    revoked.links.rows = ctx.links.rows;
    const result = await revoked.svc.sweep();
    expect(result.closed).toBe(1);
    expect(link.state).toBe(WireGuardLinkState.CLOSED);
    expect(link.closeReason).toMatch(/b1 left/);
  });

  it('leaves healthy open links alone in a sweep', async () => {
    const { svc, calls } = setup();
    const link = await svc.open(openInput);
    calls.length = 0;
    await svc.sweep();
    expect(calls).toEqual([]);
    expect(link.state).toBe(WireGuardLinkState.OPEN);
  });
});
