import { udpPortLine, udpPortsHint } from './udp-ports';

describe('UDP ports in the CLI', () => {
  it('says what a closed port needs and where', () => {
    const view = {
      clusterId: 'c',
      firewallId: 'f',
      ports: [{ name: 'media', port: 10000, state: 'closed' as const }],
    };
    expect(udpPortLine(view.ports[0])).toBe('UDP 10000 (media)  closed');
    expect(udpPortsHint(view)).toContain('Cluster Firewalls');
  });

  it('names the app holding a port', () => {
    expect(
      udpPortLine({
        name: 'media',
        port: 10000,
        state: 'open',
        takenBy: 'calls',
      }),
    ).toBe('UDP 10000 (media)  open, already used by calls');
  });

  it('stays quiet when every port is open', () => {
    expect(
      udpPortsHint({
        clusterId: 'c',
        firewallId: 'f',
        ports: [{ name: 'media', port: 10000, state: 'open' }],
      }),
    ).toBeNull();
  });
});
