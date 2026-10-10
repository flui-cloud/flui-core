import * as yaml from 'js-yaml';
import { fluiRegistryConfigFrom } from './flui-registry.config';
import { renderRegistryManifests } from './registry-manifest';

const config = fluiRegistryConfigFrom(
  (key) =>
    ({
      FLUI_IMAGE_REGISTRY: 'flui',
      PUBLIC_API_URL: 'https://api.example.test',
    })[key],
);

const render = (publicKeyPem = 'PEM-1') =>
  yaml.loadAll(
    renderRegistryManifests({
      config,
      host: 'api.example.test',
      publicKeyPem,
      tls: { secretName: 'flui-system-tls' },
    }),
  ) as Array<Record<string, any>>;

const byKind = (docs: Array<Record<string, any>>, kind: string) =>
  docs.find((d) => d.kind === kind)!;

describe('the registry put on the control cluster', () => {
  it('trusts only tokens from the API’s realm, signed by the API’s key', () => {
    const secret = byKind(render(), 'Secret');
    const server = JSON.parse(secret.stringData['config.json']);
    expect(server.http.auth).toEqual({
      bearer: {
        realm: 'https://api.example.test/api/v1/registry/token',
        service: 'flui-registry',
        cert: '/etc/zot/auth/registry.pem',
      },
    });
    expect(server.http.accessControl).toBeUndefined();
    expect(server.extensions).toBeUndefined();
    expect(secret.stringData['registry.pem']).toBe('PEM-1');
  });

  it('keeps the most recently pushed and the most recently pulled images of each application', () => {
    const server = JSON.parse(
      byKind(render(), 'Secret').stringData['config.json'],
    );
    expect(server.storage.gc).toBe(true);
    expect(server.storage.retention.policies).toEqual([
      expect.objectContaining({
        repositories: ['apps/**'],
        keepTags: [
          { mostRecentlyPushedCount: 3 },
          { mostRecentlyPulledCount: 3 },
        ],
      }),
    ]);
  });

  it('answers on the API host under /v2, above the API’s route, never its own extensions', () => {
    const route = byKind(render(), 'IngressRoute').spec;
    expect(route.entryPoints).toEqual(['websecure']);
    expect(route.routes[0].priority).toBeGreaterThan(100);
    expect(route.routes[0].match).toBe(
      'Host(`api.example.test`) && (Path(`/v2`) || PathPrefix(`/v2/`)) && !PathPrefix(`/v2/_zot`)',
    );
    expect(route.tls).toEqual({ secretName: 'flui-system-tls' });
  });

  it('restarts the registry when the key it trusts changes', () => {
    const revision = (pem: string) =>
      byKind(render(pem), 'Deployment').spec.template.metadata.annotations[
        'flui.cloud/registry-revision'
      ];
    expect(revision('PEM-1')).toBe(revision('PEM-1'));
    expect(revision('PEM-2')).not.toBe(revision('PEM-1'));
  });
});

describe('what stands in front of the registry', () => {
  const docs = (env: Record<string, string>) =>
    yaml.loadAll(
      renderRegistryManifests({
        config: fluiRegistryConfigFrom(
          (key) =>
            ({
              FLUI_IMAGE_REGISTRY: 'flui',
              PUBLIC_API_URL: 'https://api.example.test',
              ...env,
            })[key],
        ),
        host: 'api.example.test',
        publicKeyPem: 'PEM',
        tls: {},
      }),
    ) as Array<Record<string, any>>;

  it('limits the request rate by default, and caps an upload when asked to', () => {
    const rendered = docs({ FLUI_REGISTRY_MAX_REQUEST_MB: '2048' });
    const route = rendered.find((d) => d.kind === 'IngressRoute')!.spec
      .routes[0];
    expect(route.middlewares).toEqual([
      { name: 'flui-registry-rate' },
      { name: 'flui-registry-size' },
    ]);
    const size = rendered.find(
      (d) => d.metadata.name === 'flui-registry-size',
    )!;
    expect(size.spec.buffering.maxRequestBodyBytes).toBe(2048 * 1024 * 1024);
    const rate = rendered.find(
      (d) => d.metadata.name === 'flui-registry-rate',
    )!;
    expect(rate.spec.rateLimit).toEqual({
      average: 100,
      burst: 200,
      period: '1s',
    });
  });

  it('puts nothing in front when both are turned off', () => {
    const route = docs({ FLUI_REGISTRY_RATE_AVERAGE: '0' }).find(
      (d) => d.kind === 'IngressRoute',
    )!.spec.routes[0];
    expect(route.middlewares).toBeUndefined();
  });
});

describe('where clients ask for tokens', () => {
  it('can be sent elsewhere than the registry host', () => {
    const config = fluiRegistryConfigFrom(
      (key) =>
        ({
          FLUI_IMAGE_REGISTRY: 'flui',
          PUBLIC_API_URL: 'https://api.example.test',
          FLUI_REGISTRY_REALM:
            'https://auth.example.test/api/v1/registry/token',
        })[key],
    );
    const secret = (
      yaml.loadAll(
        renderRegistryManifests({
          config,
          host: 'api.example.test',
          publicKeyPem: 'PEM',
          tls: {},
        }),
      ) as Array<Record<string, any>>
    ).find((d) => d.kind === 'Secret')!;
    expect(
      JSON.parse(secret.stringData['config.json']).http.auth.bearer.realm,
    ).toBe('https://auth.example.test/api/v1/registry/token');
  });
});

describe('how long one upload or download may take', () => {
  it('outlasts the registry default of 60 s, which cuts a large layer', () => {
    const secret = (
      yaml.loadAll(
        renderRegistryManifests({
          config,
          host: 'api.example.test',
          publicKeyPem: 'PEM',
          tls: {},
        }),
      ) as Array<Record<string, any>>
    ).find((d) => d.kind === 'Secret')!;
    const http = JSON.parse(secret.stringData['config.json']).http;
    expect(http.readTimeout).toBe('600s');
    expect(http.writeTimeout).toBe('600s');
  });
});

describe('the registry on object storage', () => {
  const s3Config = fluiRegistryConfigFrom(
    (key) =>
      ({
        FLUI_IMAGE_REGISTRY: 'flui',
        PUBLIC_API_URL: 'https://api.example.test',
        FLUI_REGISTRY_STORAGE_BACKEND: 's3',
        FLUI_REGISTRY_REPLICAS: '3',
      })[key],
  );
  const bucket = {
    endpoint: 'https://s3.fr-par.scw.cloud',
    region: 'fr-par',
    bucket: 'flui-registry-abc',
    prefix: 'zot',
    forcePathStyle: false,
    accessKey: 'SCWACCESSKEY',
    secretKey: 'scw-secret-key',
  };
  const docs = () =>
    yaml.loadAll(
      renderRegistryManifests({
        config: s3Config,
        host: 'api.example.test',
        publicKeyPem: 'PEM',
        tls: {},
        objectStorage: { s3: bucket, cachePassword: 'cache-secret' },
      }),
    ) as Array<Record<string, any>>;
  const named = (kind: string, name: string) =>
    docs().find((d) => d.kind === kind && d.metadata.name === name)!;
  const configs = () =>
    named('Secret', 'flui-registry-config').stringData as Record<
      string,
      string
    >;

  it('serves from several copies that never collect garbage, and keeps with one that does', () => {
    const serve = named('Deployment', 'flui-registry').spec;
    const maintain = named('Deployment', 'flui-registry-maintenance').spec;
    expect(serve.replicas).toBe(3);
    expect(serve.strategy.type).toBe('RollingUpdate');
    expect(maintain.replicas).toBe(1);

    const serving = JSON.parse(configs()['config.json']).storage;
    const keeping = JSON.parse(configs()['maintain.json']).storage;
    expect(serving.gc).toBe(false);
    expect(serving.retention).toBeUndefined();
    expect(keeping.gc).toBe(true);
    expect(keeping.retention.policies[0].repositories).toEqual(['apps/**']);
  });

  it('takes a copy out of the route before it stops, and spreads the copies over nodes', () => {
    const pod = named('Deployment', 'flui-registry').spec.template.spec;
    const registry = pod.containers[0];
    expect(registry.readinessProbe.httpGet).toEqual({
      path: '/readyz',
      port: 5000,
    });
    expect(registry.lifecycle.preStop.sleep.seconds).toBeGreaterThan(0);
    expect(
      pod.affinity.podAntiAffinity
        .preferredDuringSchedulingIgnoredDuringExecution[0].podAffinityTerm
        .topologyKey,
    ).toBe('kubernetes.io/hostname');
    expect(
      named('Deployment', 'flui-registry-maintenance').spec.template.spec
        .affinity,
    ).toBeUndefined();
  });

  it('starts the cache again, empty, when the bucket or its password changes, and only then', () => {
    const cacheRevision = (
      s3: typeof bucket,
      cachePassword: string,
      keepTags = '3',
    ) =>
      (
        yaml.loadAll(
          renderRegistryManifests({
            config: fluiRegistryConfigFrom(
              (key) =>
                ({
                  FLUI_IMAGE_REGISTRY: 'flui',
                  FLUI_REGISTRY_STORAGE_BACKEND: 's3',
                  FLUI_REGISTRY_KEEP_TAGS: keepTags,
                })[key],
            ),
            host: 'api.example.test',
            publicKeyPem: 'PEM',
            tls: {},
            objectStorage: { s3, cachePassword },
          }),
        ) as Array<Record<string, any>>
      ).find(
        (d) =>
          d.kind === 'Deployment' && d.metadata.name === 'flui-registry-cache',
      )!.spec.template.metadata.annotations['flui.cloud/registry-revision'];
    const first = cacheRevision(bucket, 'one');
    expect(cacheRevision(bucket, 'one', '5')).toBe(first);
    expect(cacheRevision(bucket, 'two')).not.toBe(first);
    expect(
      cacheRevision({ ...bucket, bucket: 'flui-registry-new' }, 'one'),
    ).not.toBe(first);
  });

  it('carries the labels the platform memory alerts select on', () => {
    const podLabels = (name: string) =>
      named('Deployment', name).spec.template.metadata.labels;
    for (const [name, appName] of [
      ['flui-registry', 'flui-registry'],
      ['flui-registry-maintenance', 'flui-registry'],
      ['flui-registry-cache', 'flui-registry-cache'],
    ]) {
      expect(podLabels(name)).toMatchObject({
        'app.kubernetes.io/managed-by': 'flui-cloud',
        'app.kubernetes.io/name': appName,
      });
    }
  });

  it('shares deduplication and pull history through its own cache', () => {
    const storage = JSON.parse(configs()['config.json']).storage;
    expect(storage.remoteCache).toBe(true);
    expect(storage.cacheDriver).toMatchObject({
      name: 'redis',
      url: 'redis://:cache-secret@flui-registry-cache:6379',
    });
    expect(storage.storageDriver).toMatchObject({
      name: 's3',
      bucket: 'flui-registry-abc',
      rootdirectory: '/zot',
      secure: true,
    });
  });

  it('routes traffic only to the serving copies', () => {
    expect(named('Service', 'flui-registry').spec.selector).toEqual({
      app: 'flui-registry',
      'flui.cloud/registry-role': 'serve',
    });
  });

  it('puts the bucket credential and the cache password in Secrets only', () => {
    const outsideSecrets = docs()
      .filter((d) => d.kind !== 'Secret')
      .map((d) => JSON.stringify(d))
      .join('\n');
    expect(outsideSecrets).not.toContain('scw-secret-key');
    expect(outsideSecrets).not.toContain('SCWACCESSKEY');
    expect(outsideSecrets).not.toContain('cache-secret');
    expect(docs().some((d) => d.kind === 'PersistentVolumeClaim')).toBe(false);
  });

  it('refuses to render without a connected bucket', () => {
    expect(() =>
      renderRegistryManifests({
        config: s3Config,
        host: 'api.example.test',
        publicKeyPem: 'PEM',
        tls: {},
      }),
    ).toThrow(/no bucket is connected/);
  });
});

describe('the registry on a filesystem volume', () => {
  it('uses the storage class it is told, and one copy', () => {
    const config = fluiRegistryConfigFrom(
      (key) =>
        ({
          FLUI_IMAGE_REGISTRY: 'flui',
          PUBLIC_API_URL: 'https://api.example.test',
          FLUI_REGISTRY_STORAGE_CLASS: 'flui-shared',
        })[key],
    );
    const docs = yaml.loadAll(
      renderRegistryManifests({
        config,
        host: 'api.example.test',
        publicKeyPem: 'PEM',
        tls: {},
      }),
    ) as Array<Record<string, any>>;
    expect(
      docs.find((d) => d.kind === 'PersistentVolumeClaim')!.spec
        .storageClassName,
    ).toBe('flui-shared');
    expect(docs.find((d) => d.kind === 'Deployment')!.spec.replicas).toBe(1);
    expect(docs.some((d) => d.metadata.name === 'flui-registry-cache')).toBe(
      false,
    );
  });

  it('refuses several copies, which would each see different images', () => {
    expect(() =>
      fluiRegistryConfigFrom(
        (key) =>
          ({ FLUI_IMAGE_REGISTRY: 'flui', FLUI_REGISTRY_REPLICAS: '2' })[key],
      ),
    ).toThrow(/needs FLUI_REGISTRY_STORAGE_BACKEND=s3/);
    expect(() =>
      fluiRegistryConfigFrom(
        (key) => ({ FLUI_REGISTRY_STORAGE_BACKEND: 'nfs' })[key],
      ),
    ).toThrow(/filesystem" or "s3/);
  });
});
