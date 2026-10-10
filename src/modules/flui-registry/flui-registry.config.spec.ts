import {
  fluiRegistryConfigFrom,
  registryRepositoryFor,
} from './flui-registry.config';

const from = (env: Record<string, string>) =>
  fluiRegistryConfigFrom((key) => env[key]);

describe('the instance registry configuration', () => {
  it('is off unless the instance asks for it', () => {
    expect(from({}).mode).toBe('ghcr');
    expect(from({ FLUI_IMAGE_REGISTRY: 'ghcr' }).mode).toBe('ghcr');
    expect(from({ FLUI_IMAGE_REGISTRY: 'Flui' }).mode).toBe('flui');
  });

  it('refuses a mode it does not know rather than guessing', () => {
    expect(() => from({ FLUI_IMAGE_REGISTRY: 'dockerhub' })).toThrow(
      /FLUI_IMAGE_REGISTRY/,
    );
  });

  it('answers on the API host unless told otherwise', () => {
    expect(from({ PUBLIC_API_URL: 'https://api.example.com/' }).host).toBe(
      'api.example.com',
    );
    expect(
      from({
        PUBLIC_API_URL: 'https://api.example.com',
        FLUI_REGISTRY_HOST: 'registry.example.com',
      }).host,
    ).toBe('registry.example.com');
    expect(from({ API_BASE_URL: 'https://api.installed.example' }).host).toBe(
      'api.installed.example',
    );
    expect(from({}).host).toBeNull();
  });

  it('keeps token lifetimes short by default and ignores nonsense', () => {
    const defaults = from({});
    expect(defaults.pushTokenSeconds).toBe(900);
    expect(defaults.pullTokenSeconds).toBe(300);
    expect(
      from({ FLUI_REGISTRY_PULL_TOKEN_SECONDS: '-5' }).pullTokenSeconds,
    ).toBe(300);
  });

  it('gives each application one repository, by its immutable id', () => {
    expect(registryRepositoryFor('ABC-1')).toBe('apps/abc-1');
  });

  it('raises the space alert at 80% of a volume and at 50 GiB of a bucket unless told otherwise', () => {
    expect(from({})).toMatchObject({
      spaceAlertPercent: 80,
      spaceAlertGib: 50,
    });
    expect(
      from({
        FLUI_REGISTRY_SPACE_ALERT_PERCENT: '150',
        FLUI_REGISTRY_SPACE_ALERT_GIB: '0.5',
      }),
    ).toMatchObject({ spaceAlertPercent: 100, spaceAlertGib: 0.5 });
    expect(from({ FLUI_REGISTRY_SPACE_ALERT_GIB: 'lots' }).spaceAlertGib).toBe(
      50,
    );
    expect(
      from({ FLUI_REGISTRY_SPACE_ALERT_PERCENT: '0' }).spaceAlertPercent,
    ).toBe(0);
  });

  it('serves from two copies on a bucket unless told otherwise, and from one on a volume', () => {
    expect(from({ FLUI_REGISTRY_STORAGE_BACKEND: 's3' }).replicas).toBe(2);
    expect(
      from({ FLUI_REGISTRY_STORAGE_BACKEND: 's3', FLUI_REGISTRY_REPLICAS: '4' })
        .replicas,
    ).toBe(4);
    expect(from({}).replicas).toBe(1);
  });
});
