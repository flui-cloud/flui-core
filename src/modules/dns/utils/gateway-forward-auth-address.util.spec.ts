import { gatewayForwardAuthAddress } from './gateway-forward-auth-address.util';

describe('gatewayForwardAuthAddress', () => {
  const ID = 'cd7b541c-0000-4000-8000-000000000001';

  it('names the route in the address, never relying on a forwarded header', () => {
    expect(
      gatewayForwardAuthAddress(ID, {
        apiRunsOnThisCluster: false,
        publicApiUrl: 'https://api.example.com/',
      }),
    ).toBe(`https://api.example.com/api/v1/authz/gateway/${ID}`);
  });

  it('stays inside the cluster the API runs on', () => {
    expect(
      gatewayForwardAuthAddress(ID, {
        apiRunsOnThisCluster: true,
        publicApiUrl: 'https://api.example.com',
      }),
    ).toBe(
      `http://flui-api.flui-system.svc.cluster.local:3000/api/v1/authz/gateway/${ID}`,
    );
  });

  it('has no address when the API cannot be reached from the route', () => {
    expect(
      gatewayForwardAuthAddress(ID, {
        apiRunsOnThisCluster: false,
        publicApiUrl: '',
      }),
    ).toBeUndefined();
  });
});
