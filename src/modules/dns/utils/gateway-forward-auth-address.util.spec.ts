import { gatewayForwardAuthAddress } from './gateway-forward-auth-address.util';

describe('gatewayForwardAuthAddress', () => {
  const ID = 'cd7b541c-0000-4000-8000-000000000001';
  const where = {
    apiRunsOnThisCluster: false,
    relayRunsOnThisCluster: false,
    isControlCluster: true,
    publicApiUrl: 'https://api.example.com/',
  };

  it('names the route in the address, never relying on a forwarded header', () => {
    expect(gatewayForwardAuthAddress(ID, where)).toBe(
      `https://api.example.com/api/v1/authz/gateway/${ID}`,
    );
  });

  it('stays inside the cluster the API runs on', () => {
    expect(
      gatewayForwardAuthAddress(ID, {
        ...where,
        apiRunsOnThisCluster: true,
        relayRunsOnThisCluster: true,
      }),
    ).toBe(
      `http://flui-api.flui-system.svc.cluster.local:3000/api/v1/authz/gateway/${ID}`,
    );
  });

  it('asks the relay of another cluster, not the public API', () => {
    expect(
      gatewayForwardAuthAddress(ID, {
        ...where,
        isControlCluster: false,
        relayRunsOnThisCluster: true,
      }),
    ).toBe(`http://flui-authz.flui-system.svc.cluster.local/gateway/${ID}`);
  });

  it('leaves another cluster without a relay closed', () => {
    expect(
      gatewayForwardAuthAddress(ID, { ...where, isControlCluster: false }),
    ).toBeUndefined();
  });

  it('has no address when the API cannot be reached from the route', () => {
    expect(
      gatewayForwardAuthAddress(ID, { ...where, publicApiUrl: '' }),
    ).toBeUndefined();
  });
});
