jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { ConflictException } from '@nestjs/common';
import { AppEndpointService } from './app-endpoint.service';
import { EndpointModeResolverService } from './endpoint-mode-resolver.service';
import { ApplicationExposure } from '../../applications/enums/application-exposure.enum';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { CreateAppEndpointDto } from '../dto/create-app-endpoint.dto';

const CLUSTER = {
  id: 'c-1',
  name: 'control-cluster',
  masterIpAddress: '203.0.113.10',
};

const ASSIGNMENT = {
  id: 'assignment-1',
  clusterId: 'c-1',
  wildcardCertificate: true,
  dnsZone: { zoneName: 'flui.cloud' },
};

function application(slug: string, category: ApplicationCategory) {
  return {
    id: 'app-1',
    clusterId: 'c-1',
    name: slug,
    slug,
    category,
    k8sNamespace: 'flui-system',
    port: 8080,
    exposure: ApplicationExposure.PUBLIC,
  };
}

function build(
  app: ReturnType<typeof application>,
  existing: { id: string; fqdn: string; hostnameMode: HostnameMode }[],
) {
  const save = jest.fn(async (entity: Record<string, unknown>) => entity);
  const findOne = jest.fn(
    async ({ where }) =>
      existing.find(
        (e) => !where.hostnameMode || e.hostnameMode === where.hostnameMode,
      ) ?? null,
  );
  const service = new AppEndpointService(
    {
      findOne,
      find: jest.fn(async () => []),
      create: (entity: Record<string, unknown>) => entity,
      save,
    } as never,
    { findOne: jest.fn(async () => CLUSTER) } as never,
    { findOne: jest.fn(async () => ASSIGNMENT) } as never,
    { findOne: jest.fn(async () => app) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new EndpointModeResolverService(),
    {} as never,
    { assertClaimable: jest.fn() } as never,
    { activeSubdomain: jest.fn(async () => null) } as never,
    { activeSubdomain: jest.fn(async () => null) } as never,
    { resolve: jest.fn() } as never,
  );
  return { service, save, findOne };
}

const dto = {
  applicationId: 'app-1',
  clusterDnsZoneId: 'assignment-1',
  fqdn: 'console.flui.cloud',
} as CreateAppEndpointDto;

describe('AppEndpointService.createEndpoint — one address per platform application', () => {
  it.each(['flui-web', 'flui-api', 'zitadel'])(
    'refuses a second domain endpoint for %s and points to the rename',
    async (slug) => {
      const { service, save } = build(
        application(slug, ApplicationCategory.SYSTEM),
        [
          {
            id: 'ep-ip',
            fqdn: 'x.203-0-113-10.nip.io',
            hostnameMode: HostnameMode.IP,
          },
          {
            id: 'ep-old',
            fqdn: 'dashboard.flui.cloud',
            hostnameMode: HostnameMode.DOMAIN,
          },
        ],
      );

      const err = await service.createEndpoint('c-1', dto).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        error: 'platform_endpoint_exists',
        endpointId: 'ep-old',
        fqdn: 'dashboard.flui.cloud',
      });
      expect(err.getResponse().message).toContain('PUT /endpoints/ep-old');
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('creates the first endpoint of a platform application', async () => {
    const { service, save } = build(
      application('flui-web', ApplicationCategory.SYSTEM),
      [],
    );

    const endpoint = await service.createEndpoint('c-1', dto);

    expect(endpoint.fqdn).toBe('console.flui.cloud');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('creates the domain endpoint beside the install address of a fresh installation', async () => {
    const { service, save } = build(
      application('flui-api', ApplicationCategory.SYSTEM),
      [
        {
          id: 'ep-ip',
          fqdn: 'flui-api.203-0-113-10.nip.io',
          hostnameMode: HostnameMode.IP,
        },
      ],
    );

    const endpoint = await service.createEndpoint('c-1', dto);

    expect(endpoint.fqdn).toBe('console.flui.cloud');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('lets an ordinary application have several endpoints', async () => {
    const { service, save } = build(
      application('flui-web', ApplicationCategory.USER),
      [
        {
          id: 'ep-old',
          fqdn: 'shop.flui.cloud',
          hostnameMode: HostnameMode.DOMAIN,
        },
      ],
    );

    await service.createEndpoint('c-1', dto);

    expect(save).toHaveBeenCalledTimes(1);
  });
});
