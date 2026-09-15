import { BadRequestException } from '@nestjs/common';
import {
  controlInterface,
  encodeBootstrapPeers,
  meshInterface,
  isWireGuardPublicKey,
  memberInterface,
  PRIVATE_KEY_PLACEHOLDER,
  renderWireGuardConfig,
  WG_DEFAULT_MTU,
  WG_DEFAULT_PORT,
  WG_INTERFACE,
} from './wireguard-config';

// Valid 32-byte base64 keys, shaped as WireGuard emits them.
const KEY_A = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_B = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';

describe('isWireGuardPublicKey', () => {
  it('accepts a real key', () => {
    expect(isWireGuardPublicKey(KEY_A)).toBe(true);
  });

  it.each([
    ['truncated', 'ABCDEF='],
    ['unpadded', 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE'],
    ['empty', ''],
    ['a shell error captured as output', 'wg: command not found'],
  ])('rejects %s', (_label, value) => {
    expect(isWireGuardPublicKey(value)).toBe(false);
  });
});

describe('the defaults stay off flannel’s', () => {
  it('does not use wg0 or 51820', () => {
    // k3s --flannel-backend=wireguard-native claims both. Flui does not use
    // that backend today, but a future switch must not collide.
    expect(WG_INTERFACE).not.toBe('wg0');
    expect(WG_DEFAULT_PORT).not.toBe(51820);
  });
});

describe('renderWireGuardConfig', () => {
  it('never writes a private key into the file', () => {
    const cfg = renderWireGuardConfig(
      memberInterface({
        address: '10.250.0.5',
        control: {
          publicKey: KEY_A,
          address: '10.250.0.1',
          endpoint: '1.2.3.4:51821',
        },
      }),
    );
    expect(cfg).toContain(`PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`);
    expect(cfg).not.toMatch(/PrivateKey = [A-Za-z0-9+/]{43}=/);
  });

  it('sets a conservative MTU by default', () => {
    const cfg = renderWireGuardConfig({ address: '10.250.0.1', peers: [] });
    expect(cfg).toContain(`MTU = ${WG_DEFAULT_MTU}`);
  });

  it('refuses a peer whose key is not a WireGuard key', () => {
    expect(() =>
      renderWireGuardConfig({
        address: '10.250.0.1',
        peers: [{ publicKey: 'nope', allowedIps: ['10.250.0.2/32'] }],
      }),
    ).toThrow(BadRequestException);
  });

  it('refuses a peer that can never be routed to', () => {
    expect(() =>
      renderWireGuardConfig({
        address: '10.250.0.1',
        peers: [{ publicKey: KEY_A, allowedIps: [] }],
      }),
    ).toThrow(/never be routed to/);
  });

  it('refuses two peers claiming the same address', () => {
    // WireGuard accepts this and silently routes to the last peer configured,
    // blackholing the other — the kind of fault that looks like a dead node.
    expect(() =>
      renderWireGuardConfig({
        address: '10.250.0.1',
        peers: [
          { publicKey: KEY_A, allowedIps: ['10.250.0.9/32'] },
          { publicKey: KEY_B, allowedIps: ['10.250.0.9/32'] },
        ],
      }),
    ).toThrow(/claimed by two peers/);
  });
});

describe('controlInterface', () => {
  it('listens, and gives each member exactly its own /32', () => {
    const spec = controlInterface({
      address: '10.250.0.1',
      members: [
        { publicKey: KEY_A, address: '10.250.0.2', label: 'workload-1' },
        { publicKey: KEY_B, address: '10.250.0.3' },
      ],
    });
    expect(spec.listenPort).toBe(WG_DEFAULT_PORT);
    expect(spec.peers.map((p) => p.allowedIps)).toEqual([
      ['10.250.0.2/32'],
      ['10.250.0.3/32'],
    ]);
  });

  it('gives members no Endpoint, so their transport address may change freely', () => {
    const spec = controlInterface({
      address: '10.250.0.1',
      members: [{ publicKey: KEY_A, address: '10.250.0.2' }],
    });
    expect(spec.peers[0].endpoint).toBeUndefined();
  });
});

describe('memberInterface', () => {
  const spec = () =>
    memberInterface({
      address: '10.250.0.7',
      control: {
        publicKey: KEY_A,
        address: '10.250.0.1',
        endpoint: '1.2.3.4:51821',
      },
    });

  it('dials the control cluster and holds the tunnel open', () => {
    expect(spec().peers[0]).toMatchObject({
      endpoint: '1.2.3.4:51821',
      persistentKeepalive: 25,
    });
  });

  it('routes only the control address, never the whole pool', () => {
    // Widening this to the pool would turn every member into a router for the
    // others via the control cluster — the transit the design forbids.
    expect(spec().peers[0].allowedIps).toEqual(['10.250.0.1/32']);
  });

  it('does not listen', () => {
    expect(spec().listenPort).toBeUndefined();
  });
});

describe('meshInterface — a Flui-managed subnet', () => {
  const KEY_C = 'hNBBm3jY4mCMeymQ4EaLuT3SEJPUrblbgnwJAJhK8Fo=';

  const member = (over: any) => ({
    publicKey: KEY_A,
    address: '10.200.1.10',
    endpoint: '1.1.1.1:51821',
    subnetId: 'sub-a',
    ...over,
  });

  const self = member({ address: '10.200.1.10' });

  it('peers with every other node of the same subnet', () => {
    const spec = meshInterface({
      self,
      members: [
        self,
        member({
          address: '10.200.1.11',
          publicKey: KEY_B,
          endpoint: '2.2.2.2:51821',
        }),
        member({
          address: '10.200.1.12',
          publicKey: KEY_C,
          endpoint: '3.3.3.3:51821',
        }),
      ],
    });
    expect(spec.peers.map((p) => p.allowedIps)).toEqual([
      ['10.200.1.11/32'],
      ['10.200.1.12/32'],
    ]);
  });

  it('never peers with a node of another subnet', () => {
    // Isolation falls out of the topology: a node elsewhere is simply never
    // written into this config, so there is no rule to forget and no route to
    // leak.
    const spec = meshInterface({
      self,
      members: [
        self,
        member({ address: '10.200.2.10', publicKey: KEY_B, subnetId: 'sub-b' }),
      ],
    });
    expect(spec.peers).toEqual([]);
  });

  it('never peers with itself', () => {
    const spec = meshInterface({ self, members: [self] });
    expect(spec.peers).toEqual([]);
  });

  it('carries the control cluster on the same interface', () => {
    // One overlay address per node, one MTU story, one set of firewall rules:
    // a second interface would double all of that to separate peers that are
    // already distinct keys with distinct /32s.
    const spec = meshInterface({
      self,
      members: [self, member({ address: '10.200.1.11', publicKey: KEY_B })],
      control: {
        publicKey: KEY_C,
        address: '10.250.0.1',
        endpoint: '9.9.9.9:51821',
      },
    });
    expect(spec.peers.map((p) => p.allowedIps[0])).toEqual([
      '10.200.1.11/32',
      '10.250.0.1/32',
    ]);
  });

  it('does not make a node a peer of itself when it is the control', () => {
    const spec = meshInterface({
      self,
      members: [self],
      control: {
        publicKey: KEY_C,
        address: self.address,
        endpoint: '9.9.9.9:51821',
      },
    });
    expect(spec.peers).toEqual([]);
  });

  it('listens, unlike a management-overlay member', () => {
    // In a mesh either end may dial first, so there is no designated dialler.
    expect(meshInterface({ self, members: [self] }).listenPort).toBe(51821);
  });

  it('keeps the path open from both ends', () => {
    const spec = meshInterface({
      self,
      members: [self, member({ address: '10.200.1.11', publicKey: KEY_B })],
    });
    expect(spec.peers[0].persistentKeepalive).toBe(25);
  });

  it('leaves out a node nobody can dial', () => {
    // Writing it anyway would produce a config that looks complete and never
    // connects to that node.
    const spec = meshInterface({
      self,
      members: [
        self,
        member({
          address: '10.200.1.11',
          publicKey: KEY_B,
          endpoint: undefined,
        }),
      ],
    });
    expect(spec.peers).toEqual([]);
  });

  it('routes only each peer /32, never the subnet', () => {
    // Routing the whole subnet through one peer would quietly make that node a
    // router for the others.
    const spec = meshInterface({
      self,
      members: [self, member({ address: '10.200.1.11', publicKey: KEY_B })],
    });
    expect(spec.peers[0].allowedIps).toEqual(['10.200.1.11/32']);
  });

  it('renders to a config a host will accept', () => {
    const cfg = renderWireGuardConfig(
      meshInterface({
        self,
        members: [self, member({ address: '10.200.1.11', publicKey: KEY_B })],
      }),
    );
    expect(cfg).toContain('Address = 10.200.1.10/32');
    expect(cfg).toContain('ListenPort = 51821');
    expect(cfg).toContain('AllowedIPs = 10.200.1.11/32');
  });
});

describe('encodeBootstrapPeers', () => {
  const KEY_X = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
  const KEY_Y = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';

  it('survives a trip through a shell unquoted', () => {
    // `;` and `|` cannot occur in a base64 key, an IPv4 address or a host:port,
    // which is the whole reason for choosing them.
    const encoded = encodeBootstrapPeers([
      { publicKey: KEY_X, address: '10.200.1.1', endpoint: '1.1.1.1:51821' },
      { publicKey: KEY_Y, address: '10.200.1.2' },
    ]);
    expect(encoded).toBe(
      `${KEY_X}|10.200.1.1|1.1.1.1:51821;${KEY_Y}|10.200.1.2`,
    );
  });

  it('drops anything that is not a key rather than writing it to a node', () => {
    const encoded = encodeBootstrapPeers([
      { publicKey: 'sh: 1: wg: not found', address: '10.200.1.1' },
      { publicKey: KEY_X, address: '10.200.1.2' },
    ]);
    expect(encoded).toBe(`${KEY_X}|10.200.1.2`);
  });

  it('is empty when there is nobody to know about yet', () => {
    expect(encodeBootstrapPeers([])).toBe('');
  });
});
