// The service's import graph reaches ESM-only packages (Kubernetes client, jose via
// jwks-rsa) that ts-jest cannot transform; stub them — this suite touches none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ApplicationService } from './application.service';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationExposure } from '../enums/application-exposure.enum';

type FqdnMap = Map<string, string>;

const makeService = (fqdns: FqdnMap, internalZone: string | null = null) => {
  const appEndpointService = {
    mapPrimaryFqdns: jest.fn().mockResolvedValue(fqdns),
  };
  const clusterDnsZoneService = {
    getInternalHostingStatus: jest
      .fn()
      .mockResolvedValue(
        internalZone
          ? { ready: true, zoneName: internalZone }
          : { ready: false },
      ),
  };
  // toResponseDtosWithUrls uses only clusterDnsZoneService (10th) + appEndpointService
  // (11th, last); the rest of the constructor deps are unused here.
  const service = new (ApplicationService as unknown as new (
    ...args: unknown[]
  ) => ApplicationService)(
    ...new Array(9).fill(undefined),
    clusterDnsZoneService,
    appEndpointService,
  );
  return { service, appEndpointService, clusterDnsZoneService };
};

const app = (over: Partial<ApplicationEntity>): ApplicationEntity =>
  ({
    id: over.id ?? 'a',
    name: over.name ?? 'app',
    exposure: over.exposure ?? ApplicationExposure.PUBLIC,
    metadata: over.metadata,
    ...over,
  }) as ApplicationEntity;

describe('ApplicationService.toResponseDtosWithUrls', () => {
  it('builds the authoritative public URL from the endpoint fqdn (https + root path)', async () => {
    const fqdns: FqdnMap = new Map([
      ['a1', 'it-tools-125d30-3l6a9w.51-15-211-217.nip.io'],
    ]);
    const { service } = makeService(fqdns);

    const [dto] = await service.toResponseDtosWithUrls([app({ id: 'a1' })]);

    expect(dto.url).toBe(
      'https://it-tools-125d30-3l6a9w.51-15-211-217.nip.io/',
    );
  });

  it('honours the catalog entrypointPath when composing the link', async () => {
    const fqdns: FqdnMap = new Map([['a2', 'jupyter-xy.nip.io']]);
    const { service } = makeService(fqdns);

    const [dto] = await service.toResponseDtosWithUrls([
      app({ id: 'a2', metadata: { entrypointPath: '/lab' } }),
    ]);

    expect(dto.url).toBe('https://jupyter-xy.nip.io/lab');
  });

  it('never invents a URL when the endpoint is not provisioned yet', async () => {
    const { service } = makeService(new Map());
    const [dto] = await service.toResponseDtosWithUrls([app({ id: 'a3' })]);
    expect(dto.url).toBeUndefined();
  });

  it('excludes internal apps from the public-URL batch (they use internalUrl)', async () => {
    const { service, appEndpointService } = makeService(new Map());

    await service.toResponseDtosWithUrls([
      app({ id: 'pub', slug: 'pub', exposure: ApplicationExposure.PUBLIC }),
      app({ id: 'int', slug: 'int', exposure: ApplicationExposure.INTERNAL }),
    ]);

    expect(appEndpointService.mapPrimaryFqdns).toHaveBeenCalledWith(['pub']);
  });

  it('attaches internalUrl to internal apps, resolving the cluster zone once', async () => {
    const { service, clusterDnsZoneService } = makeService(
      new Map(),
      'acme.com',
    );

    const [dto] = await service.toResponseDtosWithUrls([
      app({
        id: 'i1',
        slug: 'pgweb',
        clusterId: 'c1',
        exposure: ApplicationExposure.INTERNAL,
      }),
    ]);

    expect(dto.internalUrl).toBe('https://pgweb.internal.acme.com/');
    expect(dto.url).toBeUndefined();
    expect(
      clusterDnsZoneService.getInternalHostingStatus,
    ).toHaveBeenCalledTimes(1);
  });

  it('omits internalUrl when the cluster is not internal-ready', async () => {
    const { service } = makeService(new Map(), null);
    const [dto] = await service.toResponseDtosWithUrls([
      app({ id: 'i2', slug: 'x', exposure: ApplicationExposure.INTERNAL }),
    ]);
    expect(dto.internalUrl).toBeUndefined();
  });
});
