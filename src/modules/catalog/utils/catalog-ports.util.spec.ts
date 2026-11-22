import {
  extraServicePorts,
  udpPortProblems,
  udpPortsOfSpec,
} from './catalog-ports.util';
import {
  udpPortClash,
  udpPortClashMessage,
} from '../../../common/net/public-udp';

describe('catalog UDP ports', () => {
  it('collects them from a single app and from every component', () => {
    expect(
      udpPortsOfSpec({ udpPorts: [{ name: 'media', port: 10000 }] } as never),
    ).toEqual([{ name: 'media', port: 10000 }]);
    expect(
      udpPortsOfSpec({
        components: [
          { name: 'web' },
          { name: 'jvb', udpPorts: [{ name: 'media', port: 10000 }] },
        ],
      } as never),
    ).toEqual([{ name: 'media', port: 10000 }]);
    expect(udpPortsOfSpec({ ports: [] } as never)).toEqual([]);
  });

  it('finds a port another app on the cluster already holds', () => {
    const clash = udpPortClash(
      [{ name: 'media', port: 10000 }],
      [
        { slug: 'quiet', udpPorts: null },
        { slug: 'calls', udpPorts: [{ name: 'media', port: 10000 }] },
      ],
    );
    expect(clash).toEqual({ port: 10000, holder: 'calls' });
    expect(udpPortClashMessage(clash!)).toContain('"calls"');
  });

  it('finds a port declared twice in the same app', () => {
    expect(
      udpPortClash(
        [
          { name: 'a', port: 10000 },
          { name: 'b', port: 10000 },
        ],
        [],
      ),
    ).toEqual({ port: 10000, holder: 'this app' });
  });

  it('lets different ports live side by side', () => {
    expect(
      udpPortClash(
        [{ name: 'media', port: 10001 }],
        [{ slug: 'calls', udpPorts: [{ name: 'media', port: 10000 }] }],
      ),
    ).toBeNull();
  });
});

describe('extra catalog ports', () => {
  it('keeps the ports after the main one, by name', () => {
    expect(
      extraServicePorts([
        { name: 'http', internal: 8123, expose: false },
        { name: 'native', internal: 9000, expose: false },
      ]),
    ).toEqual([{ name: 'native', port: 9000 }]);
  });

  it('skips a repeated port and a name a Service would refuse', () => {
    expect(
      extraServicePorts([
        { name: 'http', internal: 8123, expose: false },
        { name: 'again', internal: 8123, expose: false },
        { name: 'Bad_Name', internal: 9000, expose: false },
      ]),
    ).toBeNull();
  });

  it('has nothing to add for a single port', () => {
    expect(
      extraServicePorts([{ name: 'http', internal: 80, expose: true }]),
    ).toBeNull();
    expect(extraServicePorts(undefined)).toBeNull();
  });
});

describe('UDP ports in a manifest', () => {
  it('accepts well-formed ports on a single app and on components', () => {
    expect(
      udpPortProblems({ udpPorts: [{ name: 'media', port: 10000 }] }),
    ).toEqual([]);
    expect(
      udpPortProblems({
        components: [
          { name: 'jvb', udpPorts: [{ name: 'media', port: 10000 }] },
        ],
      }),
    ).toEqual([]);
  });

  it('refuses a port outside the range, a bad name and a repeat', () => {
    expect(
      udpPortProblems({
        components: [
          { udpPorts: [{ name: 'Media', port: 51820 }] },
          {
            udpPorts: [
              { name: 'a', port: 10000 },
              { name: 'b', port: 10000 },
            ],
          },
          { udpPorts: 'nope' },
        ],
      }),
    ).toEqual([
      'spec.components[0].udpPorts[0].name must be a lowercase name of up to 15 characters',
      'spec.components[0].udpPorts[0].port must be between 10000 and 10999',
      'spec.components[1].udpPorts[1].port 10000 is declared twice',
      'spec.components[2].udpPorts must be a list',
    ]);
  });
});
