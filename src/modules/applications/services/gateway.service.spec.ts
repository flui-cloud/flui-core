jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { GatewayService } from './gateway.service';

describe('GatewayService sign-in on a route', () => {
  const endpoint = {
    id: 'e1',
    applicationId: 'a1',
    fqdn: 'app.example.com',
    gatewayConfig: null,
    cluster: { id: 'c2', name: 'workload-1', clusterType: 'workload' },
  };
  const make = (address: string | undefined) => {
    const appEndpointService = {
      getEndpoint: jest.fn(async () => endpoint),
      updateGatewayConfig: jest.fn(async (_id: string, config: unknown) => ({
        ...endpoint,
        gatewayConfig: config,
      })),
    };
    const reconciliation = {
      resolveGatewayForwardAuthAddress: jest.fn(async () => address),
      syncEndpoint: jest.fn(async () => ({})),
      reconcile: jest.fn(async () => undefined),
    };
    const service = new GatewayService(
      { findById: jest.fn(async () => ({ id: 'a1' })) } as any,
      appEndpointService as any,
      reconciliation as any,
      { normalizePath: (p: string | undefined) => p ?? '/' } as any,
      {} as any,
      {} as any,
    );
    return { service, appEndpointService };
  };

  it('refuses before saving when the cluster has nothing to check the sign-in with', async () => {
    const { service, appEndpointService } = make(undefined);
    await expect(
      service.setPolicy('a1', 'e1', { auth: { sso: true } } as any),
    ).rejects.toMatchObject({
      response: { code: 'SIGN_IN_CHECK_UNAVAILABLE' },
    });
    expect(appEndpointService.updateGatewayConfig).not.toHaveBeenCalled();
  });

  it('saves it when the cluster can check the sign-in', async () => {
    const { service, appEndpointService } = make(
      'http://flui-authz.flui-system.svc.cluster.local/gateway/e1',
    );
    await service.setPolicy('a1', 'e1', { auth: { sso: true } } as any);
    expect(appEndpointService.updateGatewayConfig).toHaveBeenCalled();
  });
});
