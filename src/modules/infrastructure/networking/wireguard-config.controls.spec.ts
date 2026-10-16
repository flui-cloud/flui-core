import { BadRequestException } from '@nestjs/common';
import {
  controlInterface,
  meshInterface,
  memberInterface,
  renderWireGuardConfig,
} from './wireguard-config';

const KEY_A = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_B = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';
const KEY_C = 'hNBBm3jY4mCMeymQ4EaLuT3SEJPUrblbgnwJAJhK8Fo=';
const KEY_D = 'AvBhnd7fb29eBhWasocwevAQqcGRZI73vxFfmQuQQHk=';

const controls = [
  { publicKey: KEY_A, address: '10.250.0.1', endpoint: '1.1.1.1:51821' },
  { publicKey: KEY_B, address: '10.250.0.2', endpoint: '2.2.2.2:51821' },
  { publicKey: KEY_C, address: '10.250.0.3', endpoint: '3.3.3.3:51821' },
];

describe('a member with several control nodes', () => {
  const spec = () => memberInterface({ address: '10.250.0.9', controls });

  it('dials every control node at its own address and keeps each path open', () => {
    expect(spec().peers.map((p) => p.endpoint)).toEqual([
      '1.1.1.1:51821',
      '2.2.2.2:51821',
      '3.3.3.3:51821',
    ]);
    expect(spec().peers.every((p) => p.persistentKeepalive === 25)).toBe(true);
  });

  it('routes one /32 per control node and never the pool: no transit through any of them', () => {
    expect(spec().peers.map((p) => p.allowedIps)).toEqual([
      ['10.250.0.1/32'],
      ['10.250.0.2/32'],
      ['10.250.0.3/32'],
    ]);
  });

  it('still does not listen', () => {
    expect(spec().listenPort).toBeUndefined();
  });

  it('refuses two control nodes on one address rather than blackholing one', () => {
    expect(() =>
      renderWireGuardConfig(
        memberInterface({
          address: '10.250.0.9',
          controls: [
            controls[0],
            { ...controls[1], address: controls[0].address },
          ],
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('renders with no control at all, for a member whose control is not ready', () => {
    expect(
      memberInterface({ address: '10.250.0.9', controls: [] }).peers,
    ).toEqual([]);
  });
});

describe('a mesh node with several control nodes', () => {
  const self = {
    publicKey: KEY_D,
    address: '10.200.1.10',
    subnetId: 's',
    endpoint: '7.7.7.7',
  };

  it('peers with every control node besides its siblings', () => {
    const spec = meshInterface({ self, members: [self], controls });
    expect(spec.peers.map((p) => p.allowedIps[0])).toEqual([
      '10.250.0.1/32',
      '10.250.0.2/32',
      '10.250.0.3/32',
    ]);
  });

  it('never makes itself a peer when it is one of the control nodes', () => {
    const spec = meshInterface({
      self: { ...self, address: '10.250.0.2' },
      members: [],
      controls,
    });
    expect(spec.peers.map((p) => p.allowedIps[0])).toEqual([
      '10.250.0.1/32',
      '10.250.0.3/32',
    ]);
  });
});

describe('each control node’s own side', () => {
  it('listens on the Flui port and names no other control node', () => {
    const spec = controlInterface({
      address: '10.250.0.2',
      members: [{ publicKey: KEY_D, address: '10.250.0.9' }],
    });
    expect(spec.listenPort).toBe(51821);
    expect(spec.peers.map((p) => p.allowedIps[0])).toEqual(['10.250.0.9/32']);
    expect(spec.peers[0].endpoint).toBeUndefined();
  });
});
