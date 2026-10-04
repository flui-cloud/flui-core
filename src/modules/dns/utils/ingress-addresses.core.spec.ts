import {
  clusterIngressValues,
  ingressAddresses,
  ingressRecordTtl,
  isPublicIpv4,
  sameValues,
} from './ingress-addresses.core';

const node = (over: Partial<Parameters<typeof ingressAddresses>[0][0]>) => ({
  name: 'c-master',
  ready: true,
  servesIngress: true,
  externalIps: [],
  ...over,
});

describe('where traffic may enter a cluster', () => {
  const recorded = [
    { serverName: 'c-master', ipAddress: '49.13.132.151' },
    { serverName: 'c-worker-1', ipAddress: '49.13.200.7' },
    { serverName: 'c-worker-2', ipAddress: '10.10.1.3' },
  ];

  it('lists every ready node that runs the ingress proxy, sorted', () => {
    expect(
      ingressAddresses(
        [node({ name: 'c-worker-1' }), node({ name: 'c-master' })],
        recorded,
      ),
    ).toEqual(['49.13.132.151', '49.13.200.7']);
  });

  it('leaves out a node that is not ready or has no ingress proxy', () => {
    expect(
      ingressAddresses(
        [
          node({ name: 'c-master' }),
          node({ name: 'c-worker-1', ready: false }),
          node({ name: 'c-worker-2', servesIngress: false }),
        ],
        recorded,
      ),
    ).toEqual(['49.13.132.151']);
  });

  it('never publishes a private address recorded for a node without a public one', () => {
    expect(ingressAddresses([node({ name: 'c-worker-2' })], recorded)).toEqual(
      [],
    );
  });

  it("prefers Kubernetes' external address over the recorded one", () => {
    expect(
      ingressAddresses(
        [node({ name: 'c-worker-2', externalIps: ['10.0.0.9', '95.1.2.3'] })],
        recorded,
      ),
    ).toEqual(['95.1.2.3']);
  });
});

describe('isPublicIpv4', () => {
  it.each([
    ['49.13.132.151', true],
    ['10.10.1.3', false],
    ['172.20.0.1', false],
    ['192.168.1.5', false],
    ['100.64.0.1', false],
    ['127.0.0.1', false],
    ['169.254.1.1', false],
    ['2a01:4f8::1', false],
    ['not-an-ip', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPublicIpv4(ip)).toBe(expected);
  });
});

describe('the addresses a cluster publishes', () => {
  it('uses the measured set once there is one', () => {
    expect(
      clusterIngressValues({
        masterIpAddress: '49.13.132.151',
        metadata: {
          ingressAddresses: {
            addresses: ['49.13.132.151', '49.13.200.7'],
            measuredAt: '2026-10-03T10:00:00Z',
          },
        },
      }),
    ).toEqual(['49.13.132.151', '49.13.200.7']);
  });

  it('falls back to the master until a set has been measured', () => {
    expect(
      clusterIngressValues({ masterIpAddress: '49.13.132.151', metadata: {} }),
    ).toEqual(['49.13.132.151']);
  });

  it('shortens the TTL only when a name points at several nodes', () => {
    expect(ingressRecordTtl(300, 1)).toBe(300);
    expect(ingressRecordTtl(300, 2)).toBe(60);
    expect(ingressRecordTtl(30, 2)).toBe(30);
  });

  it('compares two answers as sets', () => {
    expect(sameValues(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameValues(['a'], ['a', 'b'])).toBe(false);
  });
});
