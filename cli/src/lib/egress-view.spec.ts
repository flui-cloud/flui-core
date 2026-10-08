import { parseEgressPorts } from './egress-view';

describe('parseEgressPorts', () => {
  it('reads TCP by default and UDP when written', () => {
    expect(parseEgressPorts('80, 443,53/udp')).toEqual([
      { port: 80, protocol: 'TCP' },
      { port: 443, protocol: 'TCP' },
      { port: 53, protocol: 'UDP' },
    ]);
  });

  it('allows an empty list, which closes every port', () => {
    expect(parseEgressPorts('')).toEqual([]);
  });

  it('refuses what is not a port', () => {
    expect(() => parseEgressPorts('smtp')).toThrow('between 1 and 65535');
    expect(() => parseEgressPorts('25/icmp')).toThrow('tcp or udp');
  });
});
