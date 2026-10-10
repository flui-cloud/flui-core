import { FluiRegistryPublisherService } from './flui-registry-publisher.service';

const config = (mode: 'ghcr' | 'flui') => ({
  mode,
  host: 'api.example.test',
  internalUrl: null,
  realm: null,
  service: 'flui-registry',
  issuer: 'flui-api',
  pushTokenSeconds: 900,
  pullTokenSeconds: 300,
  image: 'zot',
  storage: '1Gi',
  storageBackend: 'filesystem' as const,
  storageClass: null,
  replicas: 1,
  cacheImage: 'redis',
  keepTags: 3,
  appQuotaMb: 0,
  maxRequestMb: 0,
  rateAverage: 0,
  rateBurst: 0,
  ioTimeoutSeconds: 600,
  spaceAlertPercent: 80,
  spaceAlertGib: 50,
});

describe('the instance registry, seen from the rest of Flui', () => {
  it('offers nothing while the instance does not run one', () => {
    const publisher = new FluiRegistryPublisherService(
      config('ghcr'),
      {} as never,
      {} as never,
    );
    expect(publisher.host()).toBeNull();
    expect(publisher.pushTarget({ id: 'a1', slug: 'shop' })).toBeNull();
  });

  it('names where an application pushes and the secrets its build reads', () => {
    const publisher = new FluiRegistryPublisherService(
      config('flui'),
      {} as never,
      {} as never,
    );
    expect(publisher.pushTarget({ id: 'A1', slug: 'my-shop' })).toEqual({
      host: 'api.example.test',
      imageName: 'api.example.test/apps/a1',
      secrets: {
        username: 'FLUI_REGISTRY_USER_MY_SHOP',
        password: 'FLUI_REGISTRY_TOKEN_MY_SHOP',
      },
    });
  });

  it('revokes a deleted application’s credentials even when its images cannot be removed', async () => {
    const revoked: string[] = [];
    const publisher = new FluiRegistryPublisherService(
      config('flui'),
      {
        revokeForApplication: async (id: string) => {
          revoked.push(id);
        },
      } as never,
      {
        deleteRepository: async () => {
          throw new Error('registry unreachable');
        },
      } as never,
    );
    await expect(
      publisher.forgetApplication({ id: 'a1', imageRegistryHost: 'h' }),
    ).resolves.toBeUndefined();
    expect(revoked).toEqual(['a1']);
  });

  it('leaves GHCR applications’ images alone', async () => {
    const deleted: string[] = [];
    const publisher = new FluiRegistryPublisherService(
      config('flui'),
      { revokeForApplication: async () => undefined } as never,
      {
        deleteRepository: async (id: string) => {
          deleted.push(id);
          return 0;
        },
      } as never,
    );
    await publisher.forgetApplication({ id: 'a1', imageRegistryHost: null });
    expect(deleted).toEqual([]);
  });
});
