import { load } from 'js-yaml';
import {
  buildEgressNetworkPolicy,
  clusterInternalCidrs,
  describeEgress,
  parseEgressPorts,
} from './egress-policy.core';

type Policy = {
  spec: {
    policyTypes: string[];
    egress: Array<{
      to: Array<{ ipBlock: { cidr: string; except?: string[] } }>;
      ports?: Array<{ protocol: string; port: number }>;
    }>;
  };
};

const internal = clusterInternalCidrs('10.0.0.0/16');

describe('egress policy', () => {
  it('reads ports, TCP unless told otherwise, without duplicates', () => {
    expect(parseEgressPorts('443, 80,53/udp,443')).toEqual([
      { port: 53, protocol: 'UDP' },
      { port: 80, protocol: 'TCP' },
      { port: 443, protocol: 'TCP' },
    ]);
    expect(() => parseEgressPorts('70000')).toThrow('between 1 and 65535');
    expect(() => parseEgressPorts('25/sctp')).toThrow('tcp or udp');
  });

  it('writes no policy for an open rule outside a guest area', () => {
    expect(
      buildEgressNetworkPolicy('p-team', null, {
        isolated: false,
        internalCidrs: internal,
      }),
    ).toBeNull();
  });

  it('keeps the cluster reachable and opens only the allowed ports to the outside', () => {
    const doc = load(
      buildEgressNetworkPolicy(
        'p-team',
        { ports: parseEgressPorts('80,443') },
        {
          isolated: false,
          internalCidrs: internal,
        },
      )!,
    ) as Policy;

    expect(doc.spec.policyTypes).toEqual(['Egress']);
    const [inside, outside] = doc.spec.egress;
    expect(inside.to.map((t) => t.ipBlock.cidr)).toEqual([
      '10.42.0.0/16',
      '10.43.0.0/16',
      '10.0.0.0/16',
    ]);
    expect(inside.ports).toBeUndefined();
    expect(outside.to[0].ipBlock.cidr).toBe('0.0.0.0/0');
    expect(outside.ports).toEqual([
      { protocol: 'TCP', port: 80 },
      { protocol: 'TCP', port: 443 },
    ]);
  });

  it('in a guest area opens only the internet, never the private ranges', () => {
    const open = load(
      buildEgressNetworkPolicy('p-guest', null, {
        isolated: true,
        internalCidrs: internal,
      })!,
    ) as Policy;
    expect(open.spec.egress).toHaveLength(1);
    expect(open.spec.egress[0].to[0].ipBlock.except).toEqual(
      expect.arrayContaining([
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '169.254.0.0/16',
      ]),
    );
    expect(open.spec.egress[0].ports).toBeUndefined();

    const restricted = load(
      buildEgressNetworkPolicy(
        'p-guest',
        { ports: parseEgressPorts('443') },
        {
          isolated: true,
          internalCidrs: internal,
        },
      )!,
    ) as Policy;
    expect(restricted.spec.egress[0].ports).toEqual([
      { protocol: 'TCP', port: 443 },
    ]);
  });

  it('closes the outside entirely when no port is allowed', () => {
    const doc = load(
      buildEgressNetworkPolicy(
        'p-guest',
        { ports: [] },
        { isolated: true, internalCidrs: internal },
      )!,
    ) as Policy;
    expect(doc.spec.egress).toEqual([]);
  });

  it('tells people what they may reach and whom to ask', () => {
    expect(describeEgress(null)).toBe(
      'Outbound traffic is open on every port.',
    );
    expect(describeEgress({ ports: parseEgressPorts('80,443,53/udp') })).toBe(
      'Outbound traffic leaving the cluster is allowed on ports 53/udp, 80, 443; for any other port ask your administrator.',
    );
  });
});
