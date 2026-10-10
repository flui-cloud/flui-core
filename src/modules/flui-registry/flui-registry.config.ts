export type ImageRegistryMode = 'ghcr' | 'flui';
export type RegistryStorageBackend = 'filesystem' | 's3';

export interface FluiRegistryConfig {
  mode: ImageRegistryMode;
  /** Host the registry answers on, without scheme: what image references start with. */
  host: string | null;
  /** Where the API itself reaches the registry; the public host when unset. */
  internalUrl: string | null;
  /** Where clients ask for tokens; the API on the registry's host when unset. */
  realm: string | null;
  service: string;
  issuer: string;
  pushTokenSeconds: number;
  pullTokenSeconds: number;
  image: string;
  storage: string;
  storageBackend: RegistryStorageBackend;
  /** Storage class of the filesystem volume; the cluster default when unset. */
  storageClass: string | null;
  /** Copies serving pushes and pulls; more than one needs object storage. */
  replicas: number;
  cacheImage: string;
  /** Tags kept per application, most recently pushed and most recently pulled. */
  keepTags: number;
  /** Space one application's images may take before pushes are refused; 0 = no limit. */
  appQuotaMb: number;
  /** Largest single upload request the route lets through; 0 = no limit. */
  maxRequestMb: number;
  /** Requests per second per address on `/v2`, and the burst above it; 0 = no limit. */
  rateAverage: number;
  rateBurst: number;
  /** How long one request may take to read or write; the registry's own default cuts a large layer at 60 s. */
  ioTimeoutSeconds: number;
  /** On a volume: the share of it in use that raises the space alert; 0 = no alert. */
  spaceAlertPercent: number;
  /** On a bucket, which never fills: the GiB in use that raises the space alert, for what they cost; 0 = no alert. */
  spaceAlertGib: number;
}

export const FLUI_REGISTRY_NAMESPACE = 'flui-system';
export const FLUI_REGISTRY_NAME = 'flui-registry';

export const FLUI_REGISTRY_CONFIG = Symbol('FLUI_REGISTRY_CONFIG');

const REPOSITORY_PREFIX = 'apps';

/** The one repository an application's images live in. */
export function registryRepositoryFor(applicationId: string): string {
  return `${REPOSITORY_PREFIX}/${applicationId.toLowerCase()}`;
}

const seconds = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const count = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

const amount = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url.trim()).host || null;
  } catch {
    return null;
  }
};

export function fluiRegistryConfigFrom(
  get: (key: string) => string | undefined,
): FluiRegistryConfig {
  const mode = get('FLUI_IMAGE_REGISTRY')?.trim().toLowerCase();
  if (mode && mode !== 'ghcr' && mode !== 'flui') {
    throw new Error(
      `FLUI_IMAGE_REGISTRY must be "ghcr" or "flui", got "${mode}"`,
    );
  }
  const backend = get('FLUI_REGISTRY_STORAGE_BACKEND')?.trim().toLowerCase();
  if (backend && backend !== 'filesystem' && backend !== 's3') {
    throw new Error(
      `FLUI_REGISTRY_STORAGE_BACKEND must be "filesystem" or "s3", got "${backend}"`,
    );
  }
  const storageBackend: RegistryStorageBackend =
    backend === 's3' ? 's3' : 'filesystem';
  const replicas = seconds(
    get('FLUI_REGISTRY_REPLICAS'),
    storageBackend === 's3' ? 2 : 1,
  );
  if (replicas > 1 && storageBackend !== 's3') {
    throw new Error(
      'FLUI_REGISTRY_REPLICAS above 1 needs FLUI_REGISTRY_STORAGE_BACKEND=s3: copies on a filesystem volume would each see different images',
    );
  }
  return {
    mode: mode === 'flui' ? 'flui' : 'ghcr',
    host:
      get('FLUI_REGISTRY_HOST')?.trim() ||
      hostOf(get('PUBLIC_API_URL')) ||
      hostOf(get('API_BASE_URL')) ||
      hostOf(get('WEBHOOK_BASE_URL')),
    internalUrl:
      get('FLUI_REGISTRY_INTERNAL_URL')?.trim().replace(/\/$/, '') ||
      (get('KUBERNETES_SERVICE_HOST')
        ? `http://${FLUI_REGISTRY_NAME}.${FLUI_REGISTRY_NAMESPACE}.svc:5000`
        : null),
    realm: get('FLUI_REGISTRY_REALM')?.trim() || null,
    service: get('FLUI_REGISTRY_SERVICE')?.trim() || 'flui-registry',
    issuer: get('FLUI_REGISTRY_ISSUER')?.trim() || 'flui-api',
    pushTokenSeconds: seconds(get('FLUI_REGISTRY_PUSH_TOKEN_SECONDS'), 900),
    pullTokenSeconds: seconds(get('FLUI_REGISTRY_PULL_TOKEN_SECONDS'), 300),
    image:
      get('FLUI_REGISTRY_IMAGE')?.trim() || 'ghcr.io/project-zot/zot:v2.1.22',
    storage: get('FLUI_REGISTRY_STORAGE')?.trim() || '20Gi',
    storageBackend,
    storageClass: get('FLUI_REGISTRY_STORAGE_CLASS')?.trim() || null,
    replicas,
    cacheImage:
      get('FLUI_REGISTRY_CACHE_IMAGE')?.trim() ||
      'docker.io/library/redis:7.4-alpine',
    keepTags: seconds(get('FLUI_REGISTRY_KEEP_TAGS'), 3),
    appQuotaMb: count(get('FLUI_REGISTRY_APP_QUOTA_MB'), 0),
    maxRequestMb: count(get('FLUI_REGISTRY_MAX_REQUEST_MB'), 0),
    rateAverage: count(get('FLUI_REGISTRY_RATE_AVERAGE'), 100),
    rateBurst: count(get('FLUI_REGISTRY_RATE_BURST'), 200),
    ioTimeoutSeconds: seconds(get('FLUI_REGISTRY_IO_TIMEOUT_SECONDS'), 600),
    spaceAlertPercent: Math.min(
      count(get('FLUI_REGISTRY_SPACE_ALERT_PERCENT'), 80),
      100,
    ),
    spaceAlertGib: amount(get('FLUI_REGISTRY_SPACE_ALERT_GIB'), 50),
  };
}
