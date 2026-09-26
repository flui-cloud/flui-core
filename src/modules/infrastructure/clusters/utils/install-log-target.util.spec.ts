import { apiRunsInCluster, installLogTarget } from './install-log-target.util';

const ips = { publicIp: '203.0.113.7', privateIp: '10.0.1.5' };

describe('installLogTarget', () => {
  it('uses the private network from inside the control cluster', () => {
    expect(
      installLogTarget({ ...ips, controlCluster: true, apiInCluster: true }),
    ).toBe('10.0.1.5');
  });

  it('uses the public address from a laptop', () => {
    expect(
      installLogTarget({ ...ips, controlCluster: true, apiInCluster: false }),
    ).toBe('203.0.113.7');
  });

  it('uses the public address for a workload cluster, whose SSH rule lets the control plane in', () => {
    expect(
      installLogTarget({ ...ips, controlCluster: false, apiInCluster: true }),
    ).toBe('203.0.113.7');
  });

  it('falls back to what there is', () => {
    expect(
      installLogTarget({
        publicIp: null,
        privateIp: '10.0.1.5',
        controlCluster: false,
        apiInCluster: false,
      }),
    ).toBe('10.0.1.5');
    expect(
      installLogTarget({
        publicIp: '203.0.113.7',
        privateIp: null,
        controlCluster: true,
        apiInCluster: true,
      }),
    ).toBe('203.0.113.7');
  });
});

describe('apiRunsInCluster', () => {
  it('reads the variable every pod carries', () => {
    expect(apiRunsInCluster({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe(
      true,
    );
    expect(apiRunsInCluster({})).toBe(false);
  });
});
