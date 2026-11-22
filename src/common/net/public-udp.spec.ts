import {
  isAppUdpPort,
  ruleOpensUdpPort,
  udpPortStates,
  UdpRuleLike,
} from './public-udp';

const udp = (port: string): UdpRuleLike => ({
  direction: 'in',
  protocol: 'udp',
  port,
});

describe('public UDP ports', () => {
  it('accepts only the application range', () => {
    expect(isAppUdpPort(10000)).toBe(true);
    expect(isAppUdpPort(10999)).toBe(true);
    expect(isAppUdpPort(9999)).toBe(false);
    expect(isAppUdpPort(11000)).toBe(false);
    expect(isAppUdpPort(10000.5)).toBe(false);
  });

  it('reads single ports and ranges', () => {
    expect(ruleOpensUdpPort(udp('10000'), 10000)).toBe(true);
    expect(ruleOpensUdpPort(udp('10000-10010'), 10005)).toBe(true);
    expect(ruleOpensUdpPort(udp('10000-10010'), 10011)).toBe(false);
    expect(ruleOpensUdpPort(udp('10010-10000'), 10005)).toBe(false);
    expect(ruleOpensUdpPort(udp('any'), 10000)).toBe(false);
  });

  it('needs an inbound UDP rule', () => {
    expect(
      ruleOpensUdpPort(
        { direction: 'in', protocol: 'tcp', port: '10000' },
        10000,
      ),
    ).toBe(false);
    expect(
      ruleOpensUdpPort(
        { direction: 'out', protocol: 'udp', port: '10000' },
        10000,
      ),
    ).toBe(false);
  });

  it('tells open, pending, closed and unmanaged apart', () => {
    const ports = [
      { name: 'media', port: 10000 },
      { name: 'other', port: 10001 },
    ];
    expect(udpPortStates(ports, null).map((p) => p.state)).toEqual([
      'unmanaged',
      'unmanaged',
    ]);
    expect(
      udpPortStates(ports, {
        desired: [udp('10000'), udp('10001')],
        applied: [udp('10000')],
      }).map((p) => p.state),
    ).toEqual(['open', 'pending']);
    expect(
      udpPortStates(ports, { desired: [], applied: null }).map((p) => p.state),
    ).toEqual(['closed', 'closed']);
  });
});
