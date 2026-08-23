// @kubernetes/client-node@1.x ships as ESM, which jest's default transform does
// not parse; nothing here touches the cluster, only the shape of the listing.
jest.mock('@kubernetes/client-node', () => ({}));

import { ApplicationGroupingService } from './application-grouping.service';
import { ApplicationGroupType } from '../dto/application-group.dto';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';

/**
 * Decision 43 — the list people actually look at.
 *
 * Decision 34 enriched the flat listing, on the strength of an argument that
 * turned out to be wrong: the dashboard and the CLI draw from `grouped`, not
 * from the flat route. A standalone application therefore still appeared with
 * no address at all, and a component of a composed install carried none either.
 * This pins the enrichment on the shape those two clients render.
 */
describe('grouped listing carries the addresses', () => {
  const standalone = {
    id: 'a1',
    name: 'My API',
    slug: 'my-api',
    status: 'running',
    category: 'user',
    clusterId: 'c1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
  };
  const component = { ...standalone, id: 'a2', slug: 'immich-web' };

  const build = (
    apps: Array<Record<string, unknown>>,
    dtos: Array<Record<string, unknown>>,
    installs: Array<Record<string, unknown>> = [],
  ) => {
    const toResponseDtosWithUrls = jest.fn().mockResolvedValue(dtos);
    const service = new ApplicationGroupingService(
      {
        findByClusterId: jest.fn().mockResolvedValue(apps),
        toResponseDtosWithUrls,
        toResponseDto: jest.fn((a: { id: string }) => ({ id: a.id })),
      } as never,
      { find: jest.fn().mockResolvedValue(installs) } as never,
      { filterReadable: jest.fn(async (_u, a) => a) } as never,
    );
    return { service, toResponseDtosWithUrls };
  };

  it('gives a standalone group the address of its own application', async () => {
    const { service } = build(
      [standalone],
      [{ id: 'a1', url: 'https://my-api.example/', endpointStatus: 'IN_SYNC' }],
    );

    const [group] = await service.listGroupedByCluster('c1', {
      userId: 'u1',
    } as never);

    expect(group.type).toBe(ApplicationGroupType.STANDALONE);
    expect(group.url).toBe('https://my-api.example/');
    expect(group.components[0].url).toBe('https://my-api.example/');
  });

  it('gives an internal-only standalone group its internal address', async () => {
    const { service } = build(
      [standalone],
      [{ id: 'a1', internalUrl: 'https://my-api.internal.example/' }],
    );

    const [group] = await service.listGroupedByCluster('c1', {
      userId: 'u1',
    } as never);

    expect(group.url).toBeUndefined();
    expect(group.internalUrl).toBe('https://my-api.internal.example/');
  });

  it('carries the address onto every component of a composed install', async () => {
    const { service } = build(
      [component],
      [
        {
          id: 'a2',
          url: 'https://immich.example/',
          endpointStatus: ReconciliationStatus.IN_SYNC,
        },
      ],
      [
        {
          id: 'inst1',
          clusterId: 'c1',
          slug: 'immich',
          displayName: 'Immich',
          resolvedFqdn: 'immich.example',
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
          applicationIds: ['a2'],
        },
      ],
    );
    (component as Record<string, unknown>).metadata = {
      catalogInstallId: 'inst1',
    };

    const [group] = await service.listGroupedByCluster('c1', {
      userId: 'u1',
    } as never);

    expect(group.type).toBe(ApplicationGroupType.COMPOSED);
    expect(group.components[0].url).toBe('https://immich.example/');
    expect(group.components[0].composedAppName).toBe('Immich');
  });

  // The composed group's own link still follows the primary component's
  // endpoint rather than the stored hostname: `resolvedFqdn` is written when
  // the endpoint row is created, minutes before anything serves that name.
  it('withholds the composed link while the endpoint is not serving', async () => {
    const { service } = build(
      [component],
      [{ id: 'a2', endpointStatus: ReconciliationStatus.PENDING }],
      [
        {
          id: 'inst1',
          clusterId: 'c1',
          slug: 'immich',
          displayName: 'Immich',
          resolvedFqdn: 'immich.example',
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
          applicationIds: ['a2'],
        },
      ],
    );

    const [group] = await service.listGroupedByCluster('c1', {
      userId: 'u1',
    } as never);

    expect(group.url).toBeUndefined();
  });

  // One enrichment for the whole page, not one per application: the batched
  // call is what keeps this route the same cost it was.
  it('enriches every application in a single batched call', async () => {
    const { service, toResponseDtosWithUrls } = build(
      [standalone, { ...standalone, id: 'a3', slug: 'other' }],
      [{ id: 'a1' }, { id: 'a3' }],
    );

    await service.listGroupedByCluster('c1', { userId: 'u1' } as never);

    expect(toResponseDtosWithUrls).toHaveBeenCalledTimes(1);
    expect(toResponseDtosWithUrls.mock.calls[0][0]).toHaveLength(2);
  });

  // The caller decides what is in the list before anything is enriched, so a
  // filtered-out application never has its endpoint looked up either.
  it('enriches only what the caller may read', async () => {
    const toResponseDtosWithUrls = jest.fn().mockResolvedValue([{ id: 'a1' }]);
    const service = new ApplicationGroupingService(
      {
        findByClusterId: jest
          .fn()
          .mockResolvedValue([standalone, { ...standalone, id: 'a9' }]),
        toResponseDtosWithUrls,
        toResponseDto: jest.fn((a: { id: string }) => ({ id: a.id })),
      } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { filterReadable: jest.fn().mockResolvedValue([standalone]) } as never,
    );

    await service.listGroupedByCluster('c1', { userId: 'u1' } as never);

    expect(toResponseDtosWithUrls.mock.calls[0][0]).toEqual([standalone]);
  });
});
