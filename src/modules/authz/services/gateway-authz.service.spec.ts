import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GatewayAuthzService } from './gateway-authz.service';

describe('GatewayAuthzService.authorizeRoute', () => {
  const route = {
    id: 'cd7b541c-0000-4000-8000-000000000001',
    fqdn: 'whoami.example.com',
    serviceName: 'whoami',
    gatewayConfig: { auth: { sso: true } },
    application: { slug: 'whoami' },
  };
  const apiRoute = {
    id: 'aaaaaaaa-0000-4000-8000-000000000002',
    fqdn: 'api.example.com',
    gatewayConfig: null,
  };

  function build() {
    const findOne = jest.fn(
      async ({ where }: { where: Record<string, string> }) =>
        [route, apiRoute].find((r) =>
          where.id ? r.id === where.id : r.fqdn === where.fqdn,
        ) ?? null,
    );
    const service = new GatewayAuthzService(
      { findOne } as never,
      { check: jest.fn().mockResolvedValue(true) } as never,
    );
    return { service, findOne };
  }

  const user = { userId: 'u1', isAdmin: true } as never;

  it('resolves the route from its id, whatever host the check arrived with', async () => {
    const { service } = build();
    await expect(service.authorizeRoute(user, route.id)).resolves.toMatchObject(
      {
        appSlug: 'whoami',
      },
    );
  });

  it('shows why the host-based check denied everyone: a rewritten host names the API route', async () => {
    const { service } = build();
    await expect(
      service.authorize(user, 'api.example.com'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an unknown route id', async () => {
    const { service } = build();
    await expect(
      service.authorizeRoute(user, 'bbbbbbbb-0000-4000-8000-000000000003'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
