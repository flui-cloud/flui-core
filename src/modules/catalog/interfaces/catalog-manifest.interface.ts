import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { CatalogAppType } from '../enums/catalog-app-type.enum';
import { ScalingPolicyPreset } from '../enums/scaling-policy-preset.enum';
import { VpaMode } from '../enums/vpa-mode.enum';

export interface CatalogManifest {
  kind: 'CatalogApp';
  apiVersion: 'flui/v1';
  metadata: CatalogMetadata;
  spec: CatalogSpec;
}

export interface CatalogMetadata {
  id: string;
  name: string;
  description?: string;
  /**
   * Macro-category that drives top-level menu placement on the dashboard.
   * Strict enum, required. The legacy free-text `category` is preserved
   * as a finer-grained UX tag (e.g. "database-tools", "productivity").
   */
  appKind: ApplicationKind;
  category: string;
  tags?: string[];
  license?: string;
  version: string;
  icon?: string;
  links?: CatalogLinks;
  ratings?: CatalogRatings;
  alternativeTo?: string[];
  /**
   * ISO date (YYYY-MM-DD) of the last time this manifest was reviewed or
   * edited. Used by the dashboard to surface stale entries ("maintained
   * 3 months ago") and to drive policy ("re-review seeds older than 6 months").
   */
  maintainedAt?: string;
  /**
   * Path to append to the app's base URL for the dashboard's "Open app" link.
   * Default "/". Use this for apps whose root does not serve a user-facing UI
   * (e.g. PocketBase where "/" returns 404 and "/_/" is the admin UI).
   */
  entrypointPath?: string;
  /**
   * Building-block slugs this app is a client/UI for (e.g. pgweb → ['postgresql'],
   * dbgate → ['mariadb', 'postgresql', 'valkey']). The dashboard surfaces this
   * app under "Compatible clients" on each listed BB's install page. Pairs with
   * `spec.linkedBuildingBlocks` for env wiring at connect time.
   */
  clientFor?: string[];
  /**
   * Subset of `clientFor`: building-block slugs for which this app is the
   * recommended/default client. The `GET /catalog/:slug/clients` endpoint
   * surfaces a per-target `isDefault` flag derived from this list, so the UI
   * can pre-select the default in a "pick a client" picker.
   */
  clientDefaultFor?: string[];
  /** When true, seeded as unpublished — hidden from GET /catalog. */
  draft?: boolean;
}

export interface CatalogLinks {
  website?: string;
  docs?: string;
  source?: string;
}

export interface CatalogRatings {
  wow?: number;
  utility?: number;
  euFit?: number;
  community?: number;
}

export type CatalogSpec =
  | CatalogSpecStandalone
  | CatalogSpecBuildingBlock
  | CatalogSpecComposed;

export type CatalogExposure = 'public' | 'internal';

export interface CatalogSpecStandalone {
  type: CatalogAppType.STANDALONE;
  image: CatalogImageSource;
  ports: CatalogPort[];
  volumes?: CatalogVolume[];
  /**
   * Placement strategy for the app's persistent volumes. Defaults to
   * `shared`. Set to `dedicated` for databases that cannot tolerate NFS
   * semantics (Postgres, MariaDB, MongoDB, …).
   */
  persistence?: CatalogPersistence;
  env: CatalogEnvVar[];
  resources: CatalogResources;
  scaling: CatalogScaling;
  healthcheck?: CatalogHealthcheck;
  /**
   * Controls how the app is reached. `public` (default) generates Ingress +
   * Certificate + DNS on a public hostname. `internal` skips all public
   * exposure: only Deployment + Service ClusterIP are created; the app is
   * reachable only from the Flui dashboard via the ForwardAuth proxy on a
   * wildcard internal hostname.
   */
  exposure?: CatalogExposure;
  privatizable?: boolean;
  domain?: CatalogDomainSpec;
  auth?: CatalogAuth;
  postInstall?: CatalogPostInstallStep[];
  startCommand?: string;
  /**
   * Exec-form entrypoint override (full argv, run without a shell). Use instead
   * of `startCommand` for distroless images that have no /bin/sh (e.g. Garage).
   */
  command?: string[];
  securityContext?: CatalogSecurityContext;
  /**
   * Static config files mounted into the container from the app Secret
   * (e.g. a `garage.toml`). Each entry's `content` is rendered verbatim;
   * inject any secrets via env instead of templating them here.
   */
  configFiles?: CatalogConfigFile[];
  /**
   * Per-BB linking declarations. The `ref` of each entry must be present in
   * `metadata.clientFor`. At connect time the installer picks the entry whose
   * `ref` matches the target BB's catalog slug and resolves its envMapping.
   */
  linkedBuildingBlocks?: CatalogLinkedBuildingBlock[];
  dependencies?: CatalogDependency[];
  smokeTest?: CatalogSmokeTest;
}

/**
 * A configuration file rendered into the app Secret and mounted read-only at
 * `path`. Content is static — secrets belong in env (`valueFrom.generate`),
 * not interpolated into the file.
 */
export interface CatalogConfigFile {
  path: string;
  content: string;
}

/** Pod/container security; only the set fields are emitted into the workload. */
export interface CatalogSecurityContext {
  /** GID of the image's non-root user so it can write mounted volumes (emitted with `fsGroupChangePolicy: OnRootMismatch`). */
  fsGroup?: number;
  runAsUser?: number;
  runAsGroup?: number;
  /** Opt-in: a root-entrypoint image (postgres, gitea) would fail with this set. */
  runAsNonRoot?: boolean;
  /** Baseline hardening: no privilege escalation, drop all caps, RuntimeDefault seccomp. */
  hardened?: boolean;
}

export interface CatalogLinkedBuildingBlock {
  ref: string;
  envMapping: CatalogLinkedEnv[];
}

export interface CatalogLinkedEnv {
  name: string;
  fromService?: 'host' | 'port';
  fromBBEnv?: string;
  /**
   * Literal value emitted as a plain env entry. Used when the env is BB-specific
   * but not derivable from the BB itself (e.g. DbGate's ENGINE_x=mariadb@dbgate-plugin-mysql,
   * LABEL_x=MariaDB, CONNECTIONS=MARIADB). Mutually exclusive with fromService/fromBBEnv.
   */
  value?: string;
}

export interface CatalogSpecBuildingBlock {
  type: CatalogAppType.BUILDING_BLOCK;
  image: CatalogImageSource;
  ports: CatalogPort[];
  volumes?: CatalogVolume[];
  persistence?: CatalogPersistence;
  env: CatalogEnvVar[];
  resources: CatalogResources;
  scaling: CatalogScaling;
  healthcheck: CatalogHealthcheck;
  startCommand?: string;
  /** Exec-form entrypoint override (argv, no shell) — for distroless images. */
  command?: string[];
  securityContext?: CatalogSecurityContext;
  configFiles?: CatalogConfigFile[];
  auth?: CatalogAuth;
  postInstall?: CatalogPostInstallStep[];
  smokeTest?: CatalogSmokeTest;
  dependencies?: CatalogDependency[];
}

export interface CatalogSpecComposed {
  type: CatalogAppType.COMPOSED;
  scalingPolicy?: CatalogScalingPolicy;
  networking?: CatalogComposedNetworking;
  domain?: CatalogDomainSpec;
  auth?: CatalogAuth;
  options?: CatalogOption[];
  postInstall?: CatalogPostInstallStep[];
  components: CatalogComponent[];
}

export interface CatalogOption {
  key: string;
  label: string;
  description?: string;
  default?: boolean;
}

export type CatalogAuthMode = 'oidc' | 'proxy' | 'native' | 'none';

export interface CatalogAuth {
  mode?: CatalogAuthMode;
  modes?: CatalogAuthMode[];
  default?: CatalogAuthMode;
  oidc?: CatalogAuthOidc;
  proxy?: CatalogAuthProxy;
}

export interface CatalogAuthOidc {
  redirectPath?: string;
  redirectPaths?: string[];
  scopes?: string[];
  /** Composed apps: component receiving the OIDC env/config when it differs from the exposed one (e.g. Penpot backend). Defaults to primary. */
  targetComponent?: string;
  /** Extra env injected into the target component only in OIDC mode, alongside the client credentials. */
  extraEnv?: Record<string, string>;
  envMapping?: {
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
    enabledFlag?: string;
  };
  configFile?: {
    path: string;
    env: string;
    template: string;
  };
}

export interface CatalogAuthProxy {
  headerMapping?: Record<string, string>;
}

export interface CatalogPostInstallStep {
  name: string;
  description?: string;
  when?: {
    authMode?: CatalogAuthMode | CatalogAuthMode[];
    option?: string;
  };
  http?: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    headers?: Record<string, string>;
    body?: string;
    expectStatus?: number[];
  };
  exec?: {
    command: string[];
    container?: string;
  };
}

export interface CatalogComponent {
  name: string;
  image: CatalogImageSource;
  ports?: CatalogPort[];
  volumes?: CatalogVolume[];
  persistence?: CatalogPersistence;
  env: CatalogEnvVar[];
  resources: CatalogResources;
  scaling: CatalogScaling;
  healthcheck?: CatalogHealthcheck;
  securityContext?: CatalogSecurityContext;
  startCommand?: string;
  /** Exec-form entrypoint override (argv, no shell) — for distroless images. */
  command?: string[];
  configFiles?: CatalogConfigFile[];
  dependsOn?: string[];
  when?: {
    option?: string;
  };
}

export interface CatalogComposedNetworking {
  internal: string;
}

export interface CatalogScalingPolicy {
  mode: ScalingPolicyPreset;
  notifications?: CatalogScalingNotifications;
}

export interface CatalogScalingNotifications {
  onScaleUp?: boolean;
  onOOMKill?: boolean;
  onScaleDown?: boolean;
  onVerticalResize?: boolean;
}

export interface CatalogImageSource {
  registry?: string;
  repository?: string;
  tag?: string;
  credentials?: CatalogImageCredentials;
  source?: CatalogImageBuildSource;
}

export interface CatalogImageCredentials {
  type: 'registry' | 'git-token';
  secretRef: string;
}

export interface CatalogImageBuildSource {
  type: 'git';
  url: string;
  branch: string;
  dockerfile?: string;
}

export interface CatalogPort {
  name: string;
  internal: number;
  expose: boolean;
  protocol?: 'http' | 'tcp';
}

export interface CatalogVolume {
  name: string;
  mountPath: string;
  required?: boolean;
  size?: string;
}

/**
 * Placement strategy for catalog apps that own a PersistentVolumeClaim.
 *
 * - `shared` (default): the PVC lives on the cluster shared storage
 *   (`flui-shared`, NFS-backed). Pods can land on any node; reads/writes
 *   go through the NFS export. Safe for stateless apps with light I/O
 *   (uploads, caches, small SQLite, file storage).
 *
 * - `dedicated`: the app pins to the master node so it writes DIRECTLY to
 *   the cluster's backing Volume (no NFS hop). Required for databases
 *   (PostgreSQL, MariaDB, MongoDB, …) because NFS breaks fsync/locking
 *   semantics and risks data corruption.
 *
 *   Today `dedicated` is implemented as pin-to-master because the workload
 *   cluster has one master + an attached block Volume. When we later add
 *   per-node CSI drivers, `dedicated` can evolve into "one block volume
 *   per app" without a manifest change.
 */
export type CatalogPersistenceScope = 'shared' | 'dedicated';

export interface CatalogPersistence {
  scope: CatalogPersistenceScope;
}

export interface CatalogEnvVar {
  name: string;
  value?: string;
  /**
   * When true, the resolved value is stored in the component's Secret (encrypted) and injected
   * via secretKeyRef, never as a plaintext ConfigMap entry. Use it on any env carrying sensitive
   * data — typically a `value` referencing another component's secret (e.g. a DB password).
   * `valueFrom.generate` and a `userInput` marked `sensitive` are always secrets regardless.
   */
  secret?: boolean;
  valueFrom?: CatalogValueFrom;
  userEditable?: boolean;
  description?: string;
}

export type CatalogValueFrom =
  | CatalogValueFromGenerate
  | CatalogValueFromSecretRef
  | CatalogValueFromUserInput;

export interface CatalogValueFromGenerate {
  generate: 'secret';
  length: number;
  /**
   * Encoding of the generated secret. Default is `base64url` (URL-safe
   * alphabet, ~190 bits of entropy at length=32). Use `hex` when the
   * consuming app expects a strict hex-only string (e.g. Homarr's
   * SECRET_ENCRYPTION_KEY is validated against `/^[0-9a-f]{64}$/`).
   */
  format?: 'base64url' | 'hex';
}

export interface CatalogValueFromSecretRef {
  secretRef: string;
}

export interface CatalogValueFromUserInput {
  userInput: CatalogUserInputPrompt;
}

export interface CatalogUserInputPrompt {
  label?: string;
  default?: string;
  sensitive?: boolean;
  placeholder?: string;
  /** JavaScript-compatible regex source (no surrounding slashes). */
  pattern?: string;
  /** Human-readable description of the pattern, shown when validation fails. */
  patternDescription?: string;
  minLength?: number;
  maxLength?: number;
  /** When true the FE must render a second "confirm" field that has to match. */
  confirm?: boolean;
  /** Hint for the FE to pick the right input type. */
  format?: 'email' | 'url' | 'password' | 'text';
}

export interface CatalogResources {
  requests?: CatalogResourceSpec;
  limits?: CatalogResourceSpec;
}

export interface CatalogResourceSpec {
  cpu?: string;
  memory?: string;
}

export interface CatalogScaling {
  horizontal: CatalogHpa;
  vertical: CatalogVpa;
}

export interface CatalogHpa {
  enabled: boolean;
  min?: number;
  max?: number;
  metrics?: CatalogHpaMetric[];
  behavior?: CatalogHpaBehavior;
}

export interface CatalogHpaMetric {
  type: 'cpu' | 'memory' | 'custom';
  target: CatalogHpaMetricTarget;
}

export interface CatalogHpaMetricTarget {
  type: 'utilization' | 'averageValue';
  value: number;
}

export interface CatalogHpaBehavior {
  scaleUp?: CatalogHpaBehaviorPolicy;
  scaleDown?: CatalogHpaBehaviorPolicy;
}

export interface CatalogHpaBehaviorPolicy {
  stabilizationWindow: string;
  step: number;
}

export interface CatalogVpa {
  enabled: boolean;
  mode?: VpaMode;
  bounds?: CatalogVpaBounds;
  updatePolicy?: CatalogVpaUpdatePolicy;
}

export interface CatalogVpaBounds {
  cpu?: CatalogVpaBoundsRange;
  memory?: CatalogVpaBoundsRange;
}

export interface CatalogVpaBoundsRange {
  min: string;
  max: string;
}

export interface CatalogVpaUpdatePolicy {
  trigger?: Array<'OOMKilled' | 'CPUThrottling'>;
  cooldown?: string;
}

export interface CatalogHealthcheck {
  type: 'http' | 'tcp' | 'exec';
  path?: string;
  port?: number;
  command?: string[];
  httpHeaders?: Record<string, string>;
  /**
   * How long Kubernetes waits after container start before the first probe.
   * Use for apps with slow cold start (JVM, Python, heavy framework boot).
   * Duration string: "60s", "2m", "1h". Default: "30s".
   */
  initialDelay?: string;
  interval?: string;
  timeout?: string;
  retries?: number;
}

export interface CatalogDomainSpec {
  auto?: boolean;
  userCustomizable?: boolean;
  tls?: boolean;

  /**
   * Hostname source for the endpoint.
   * - `ip`: nip.io against the cluster master IP (no DNS provider needed).
   * - `domain`: real DNS zone (assigned to the cluster).
   * If omitted, derived from the cluster's `endpointHostnameMode`.
   */
  hostnameMode?: 'ip' | 'domain';

  /**
   * ACME challenge type.
   * - `http-01`: works without DNS API integration. Forced when `hostnameMode=ip`.
   * - `dns-01`: requires a configured cluster DNS zone, supports wildcard certs.
   * If omitted, derived from cluster + zone configuration.
   */
  certChallenge?: 'http-01' | 'dns-01';

  /**
   * Certificate authority. `staging` is rate-limit-free but issues
   * untrusted certs — use it for testing. `production` issues real
   * trusted certs (default). Maps 1:1 to `CertificateProvider` enum.
   */
  certificateProvider?: 'lets-encrypt' | 'lets-encrypt-staging';
}

export interface CatalogDependency {
  ref: string;
  as: string;
  required?: boolean;
  reuseExisting?: boolean;
}

export interface CatalogSmokeTestHttp {
  type: 'http';
  path?: string;
  expectedStatus?: number;
  timeoutSeconds?: number;
  retries?: number;
}

export interface CatalogSmokeTestTcp {
  type: 'tcp';
  port?: number;
  timeoutSeconds?: number;
}

export interface CatalogSmokeTestScript {
  type: 'script';
  inline?: string;
  file?: string;
  shell?: string;
  timeoutSeconds?: number;
}

export interface CatalogSmokeTestSkip {
  type: 'skip';
  reason?: string;
}

export type CatalogSmokeTest =
  | CatalogSmokeTestHttp
  | CatalogSmokeTestTcp
  | CatalogSmokeTestScript
  | CatalogSmokeTestSkip;
