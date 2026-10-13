jest.mock('../../access/services/access.service', () => ({
  AccessService: class {},
}));

import { ManagementService } from './management.service';
import { CacheService } from 'src/modules/common/cache/cache.service';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

describe('ManagementService node sizes cache', () => {
  const nodeSize = { id: 'DEV1-S', availability: [] };

  function build(getNodeSizes: jest.Mock) {
    const store = new Map<string, unknown>();
    const cacheManager = {
      get: jest.fn(async (key: string) => store.get(key)),
      set: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      del: jest.fn(async (key: string) => {
        store.delete(key);
      }),
    };
    const cache = new CacheService(cacheManager as any, null);
    const providerFactory = {
      getProvider: jest.fn(() => ({ getNodeSizes })),
    };
    const capabilitiesFactory = {
      getCapabilitiesService: jest.fn(() => ({
        getStaticCapabilities: () => ({ hasLiveAvailability: false }),
      })),
    };
    const service = new ManagementService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      providerFactory as any,
      capabilitiesFactory as any,
      cache,
    );
    return { service, store };
  }

  it('asks the provider again after an empty catalog instead of serving it from cache', async () => {
    const getNodeSizes = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([nodeSize]);
    const { service } = build(getNodeSizes);

    await expect(service.getNodeSizes(CloudProvider.SCALEWAY)).resolves.toEqual(
      [],
    );
    await expect(service.getNodeSizes(CloudProvider.SCALEWAY)).resolves.toEqual(
      [nodeSize],
    );
    expect(getNodeSizes).toHaveBeenCalledTimes(2);
  });

  it('serves a non-empty catalog from cache', async () => {
    const getNodeSizes = jest.fn().mockResolvedValue([nodeSize]);
    const { service } = build(getNodeSizes);

    await service.getNodeSizes(CloudProvider.SCALEWAY);
    await service.getNodeSizes(CloudProvider.SCALEWAY);

    expect(getNodeSizes).toHaveBeenCalledTimes(1);
  });

  it('drops the cached catalog when asked to', async () => {
    const getNodeSizes = jest.fn().mockResolvedValue([nodeSize]);
    const { service, store } = build(getNodeSizes);

    await service.getNodeSizes(CloudProvider.SCALEWAY);
    await service.clearNodeSizesCache(CloudProvider.SCALEWAY);

    expect(store.size).toBe(0);
  });
});
