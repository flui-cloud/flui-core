import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import {
  FLUI_REGISTRY_NAME,
  FLUI_REGISTRY_NAMESPACE,
  FluiRegistryConfig,
} from './flui-registry.config';

const PORT = 5000;
const CACHE_PORT = 6379;
const CACHE_NAME = `${FLUI_REGISTRY_NAME}-cache`;
const MAINTENANCE_NAME = `${FLUI_REGISTRY_NAME}-maintenance`;
export const REGISTRY_ROLE_LABEL = 'flui.cloud/registry-role';
const ROLE = REGISTRY_ROLE_LABEL;
const LABELS = {
  app: FLUI_REGISTRY_NAME,
  'app.kubernetes.io/name': FLUI_REGISTRY_NAME,
  'app.kubernetes.io/managed-by': 'flui-cloud',
  'flui.cloud/managed': 'true',
  'flui.cloud/scope': 'system',
  'flui.cloud/owner-kind': 'platform',
  'flui.cloud/owner-id': 'flui-core',
};

/** The bucket the registry keeps images in, and the credential that reaches only it. */
export interface RegistryObjectStorage {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKey: string;
  secretKey: string;
}

/**
 * Which copy a configuration is for. On object storage the copies that serve
 * never collect garbage: one maintenance copy does, so the bucket is walked
 * once per pass and no two copies delete the same image.
 */
export type RegistryRole = 'serve' | 'maintain';

const retention = (config: FluiRegistryConfig) => ({
  gc: true,
  gcDelay: '1h',
  gcInterval: '1h',
  retention: {
    delay: '24h',
    policies: [
      {
        repositories: ['apps/**'],
        deleteReferrers: true,
        deleteUntagged: true,
        keepTags: [
          { mostRecentlyPushedCount: config.keepTags },
          { mostRecentlyPulledCount: config.keepTags },
        ],
      },
    ],
  },
});

const objectStorage = (s3: RegistryObjectStorage, cachePassword: string) => ({
  rootDirectory: '/var/lib/registry',
  dedupe: true,
  remoteCache: true,
  storageDriver: {
    name: 's3',
    rootdirectory: `/${trimSlashes(s3.prefix)}`,
    region: s3.region,
    regionendpoint: s3.endpoint,
    bucket: s3.bucket,
    forcepathstyle: s3.forcePathStyle,
    secure: !s3.endpoint.startsWith('http://'),
    skipverify: false,
    accesskey: s3.accessKey,
    secretkey: s3.secretKey,
  },
  cacheDriver: {
    name: 'redis',
    url: `redis://:${encodeURIComponent(cachePassword)}@${CACHE_NAME}:${CACHE_PORT}`,
    keyprefix: 'zot',
  },
});

/** What the registry is told: who signs its tokens, and what it keeps. */
export function registryServerConfig(
  config: FluiRegistryConfig,
  host: string,
  storage?: {
    s3: RegistryObjectStorage;
    cachePassword: string;
    role: RegistryRole;
  },
): Record<string, unknown> {
  const keeps = !storage || storage.role === 'maintain';
  return {
    distSpecVersion: '1.1.1',
    storage: {
      ...(storage
        ? objectStorage(storage.s3, storage.cachePassword)
        : { rootDirectory: '/var/lib/registry', dedupe: true }),
      ...(keeps ? retention(config) : { gc: false }),
    },
    http: {
      address: '0.0.0.0',
      port: String(PORT),
      readTimeout: `${config.ioTimeoutSeconds}s`,
      writeTimeout: `${config.ioTimeoutSeconds}s`,
      auth: {
        bearer: {
          realm: config.realm ?? `https://${host}/api/v1/registry/token`,
          service: config.service,
          cert: '/etc/zot/auth/registry.pem',
        },
      },
    },
    log: { level: 'info' },
  };
}

const metadata = (name: string) => ({
  name,
  namespace: FLUI_REGISTRY_NAMESPACE,
  labels: LABELS,
});

/** The router keeps sending to a stopping copy for a few seconds; a pull sent there stalls. */
const DRAIN_BEFORE_STOP = { preStop: { sleep: { seconds: 10 } } };

const spreadAcrossNodes = (role: RegistryRole) => ({
  affinity: {
    podAntiAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          weight: 100,
          podAffinityTerm: {
            topologyKey: 'kubernetes.io/hostname',
            labelSelector: {
              matchLabels: { app: FLUI_REGISTRY_NAME, [ROLE]: role },
            },
          },
        },
      ],
    },
  },
});

function registryDeployment(input: {
  name: string;
  role: RegistryRole;
  replicas: number;
  image: string;
  configFile: string;
  revision: string;
  data: Record<string, unknown>;
  rolling: boolean;
}) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: metadata(input.name),
    spec: {
      replicas: input.replicas,
      strategy: { type: input.rolling ? 'RollingUpdate' : 'Recreate' },
      selector: {
        matchLabels: { app: FLUI_REGISTRY_NAME, [ROLE]: input.role },
      },
      template: {
        metadata: {
          labels: { ...LABELS, [ROLE]: input.role },
          annotations: { 'flui.cloud/registry-revision': input.revision },
        },
        spec: {
          priorityClassName: 'flui-platform',
          ...(input.rolling ? spreadAcrossNodes(input.role) : {}),
          containers: [
            {
              name: 'registry',
              image: input.image,
              args: ['serve', `/etc/zot/auth/${input.configFile}`],
              ports: [{ containerPort: PORT, name: 'registry' }],
              readinessProbe: {
                httpGet: { path: '/readyz', port: PORT },
                periodSeconds: 5,
              },
              ...(input.rolling ? { lifecycle: DRAIN_BEFORE_STOP } : {}),
              resources: {
                requests: { cpu: '50m', memory: '128Mi' },
                limits: { memory: '1Gi' },
              },
              volumeMounts: [
                { name: 'auth', mountPath: '/etc/zot/auth', readOnly: true },
                { name: 'data', mountPath: '/var/lib/registry' },
              ],
            },
          ],
          volumes: [
            {
              name: 'auth',
              secret: { secretName: `${FLUI_REGISTRY_NAME}-config` },
            },
            { name: 'data', ...input.data },
          ],
        },
      },
    },
  };
}

/**
 * The cache and metadata every copy shares on object storage: which blobs are
 * duplicates, and when each image was last pulled. Its own instance, behind
 * its own password, so the registry never holds the platform's queue store.
 * Losing it costs deduplication of what is pushed until it refills, not images.
 * It starts again, empty, whenever the bucket or its password changes: what it
 * remembers points into one bucket, and it reads its password only at start.
 */
function cacheDocuments(
  image: string,
  password: string,
  s3: RegistryObjectStorage,
) {
  const revision = createHash('sha256')
    .update(password)
    .update(s3.endpoint)
    .update(s3.bucket)
    .update(s3.prefix)
    .digest('hex')
    .slice(0, 16);
  return [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: metadata(CACHE_NAME),
      stringData: { password },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(CACHE_NAME),
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: CACHE_NAME } },
        template: {
          metadata: {
            labels: {
              ...LABELS,
              app: CACHE_NAME,
              'app.kubernetes.io/name': CACHE_NAME,
            },
            annotations: { 'flui.cloud/registry-revision': revision },
          },
          spec: {
            priorityClassName: 'flui-platform',
            containers: [
              {
                name: 'cache',
                image,
                args: [
                  '--requirepass',
                  '$(CACHE_PASSWORD)',
                  '--save',
                  '',
                  '--appendonly',
                  'no',
                ],
                env: [
                  {
                    name: 'CACHE_PASSWORD',
                    valueFrom: {
                      secretKeyRef: { name: CACHE_NAME, key: 'password' },
                    },
                  },
                ],
                ports: [{ containerPort: CACHE_PORT, name: 'cache' }],
                resources: {
                  requests: { cpu: '20m', memory: '32Mi' },
                  limits: { memory: '256Mi' },
                },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(CACHE_NAME),
      spec: {
        selector: { app: CACHE_NAME },
        ports: [{ name: 'cache', port: CACHE_PORT, targetPort: CACHE_PORT }],
      },
    },
  ];
}

/**
 * The registry on the control cluster: answering on the API's own host under
 * `/v2`, trusting tokens signed by the API's public key and nothing else, with
 * no anonymous access and none of its own extension routes exposed.
 *
 * On a filesystem volume it is one copy that also collects garbage. On object
 * storage it is any number of copies that serve, one maintenance copy, and the
 * cache they share; the bucket's credential lives only in the config Secret.
 */
export function renderRegistryManifests(input: {
  config: FluiRegistryConfig;
  host: string;
  publicKeyPem: string;
  /** The TLS block the API's own route carries, so both answer with one certificate. */
  tls: Record<string, unknown>;
  objectStorage?: { s3: RegistryObjectStorage; cachePassword: string };
}): string {
  const { config, objectStorage: shared } = input;
  if (config.storageBackend === 's3' && !shared) {
    throw new Error(
      'The registry is set to object storage but no bucket is connected',
    );
  }
  const onS3 = config.storageBackend === 's3' && shared;
  const serveJson = JSON.stringify(
    registryServerConfig(
      config,
      input.host,
      onS3 ? { ...shared, role: 'serve' } : undefined,
    ),
    null,
    2,
  );
  const maintainJson = onS3
    ? JSON.stringify(
        registryServerConfig(config, input.host, {
          ...shared,
          role: 'maintain',
        }),
        null,
        2,
      )
    : null;
  const revision = createHash('sha256')
    .update(serveJson)
    .update(maintainJson ?? '')
    .update(input.publicKeyPem)
    .update(config.image)
    .digest('hex')
    .slice(0, 16);
  const middlewares = registryMiddlewares(config);
  const scratch = { emptyDir: {} };

  const documents = [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: metadata(`${FLUI_REGISTRY_NAME}-config`),
      stringData: {
        'config.json': serveJson,
        ...(maintainJson ? { 'maintain.json': maintainJson } : {}),
        'registry.pem': input.publicKeyPem,
      },
    },
    ...(onS3
      ? [
          ...cacheDocuments(config.cacheImage, shared.cachePassword, shared.s3),
          registryDeployment({
            name: FLUI_REGISTRY_NAME,
            role: 'serve',
            replicas: config.replicas,
            image: config.image,
            configFile: 'config.json',
            revision,
            data: scratch,
            rolling: true,
          }),
          registryDeployment({
            name: MAINTENANCE_NAME,
            role: 'maintain',
            replicas: 1,
            image: config.image,
            configFile: 'maintain.json',
            revision,
            data: scratch,
            rolling: false,
          }),
        ]
      : [
          {
            apiVersion: 'v1',
            kind: 'PersistentVolumeClaim',
            metadata: metadata(FLUI_REGISTRY_NAME),
            spec: {
              accessModes: ['ReadWriteOnce'],
              ...(config.storageClass
                ? { storageClassName: config.storageClass }
                : {}),
              resources: { requests: { storage: config.storage } },
            },
          },
          registryDeployment({
            name: FLUI_REGISTRY_NAME,
            role: 'serve',
            replicas: 1,
            image: config.image,
            configFile: 'config.json',
            revision,
            data: { persistentVolumeClaim: { claimName: FLUI_REGISTRY_NAME } },
            rolling: false,
          }),
        ]),
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(FLUI_REGISTRY_NAME),
      spec: {
        selector: { app: FLUI_REGISTRY_NAME, [ROLE]: 'serve' },
        ports: [{ name: 'registry', port: PORT, targetPort: PORT }],
      },
    },
    {
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: metadata(FLUI_REGISTRY_NAME),
      spec: {
        entryPoints: ['websecure'],
        routes: [
          {
            // Above the API's own route on the same host (priority 100), and
            // `/v2/` rather than `/v2`, which would also match `/v2-anything`.
            match: `Host(\`${input.host}\`) && (Path(\`/v2\`) || PathPrefix(\`/v2/\`)) && !PathPrefix(\`/v2/_zot\`)`,
            kind: 'Rule',
            priority: 1000,
            ...(middlewares.length
              ? {
                  middlewares: middlewares.map((m) => ({
                    name: m.metadata.name,
                  })),
                }
              : {}),
            services: [{ name: FLUI_REGISTRY_NAME, port: PORT }],
          },
        ],
        tls: input.tls,
      },
    },
    ...middlewares,
  ];
  return documents
    .map((doc) => yaml.dump(doc, { lineWidth: -1 }))
    .join('---\n');
}

/**
 * What stands between the internet and the registry: a request rate per
 * address, and a ceiling on one upload so a single push cannot fill the disk
 * before the per-application quota is next consulted.
 */
function registryMiddlewares(config: FluiRegistryConfig) {
  const middleware = (suffix: string, spec: Record<string, unknown>) => ({
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: metadata(`${FLUI_REGISTRY_NAME}-${suffix}`),
    spec,
  });
  return [
    ...(config.rateAverage > 0
      ? [
          middleware('rate', {
            rateLimit: {
              average: config.rateAverage,
              burst: Math.max(config.rateBurst, config.rateAverage),
              period: '1s',
            },
          }),
        ]
      : []),
    ...(config.maxRequestMb > 0
      ? [
          middleware('size', {
            buffering: {
              maxRequestBodyBytes: config.maxRequestMb * 1024 * 1024,
            },
          }),
        ]
      : []),
  ];
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}
