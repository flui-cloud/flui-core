import { ApiClient } from '../api-client';
import { ConfigStorage } from '../config-storage';
import type { EndpointSyncOutcome } from 'src/modules/dns/utils/endpoint-sync.core';
import type { CertificatePhase } from 'src/modules/dns/utils/certificate-phase.core';

export interface AppSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  replicas: number;
  kind: string;
  exposure: string;
  lastDeployedAt?: string;
  clusterId: string;
  sourceType?: string;
  /** Null for a system application, which belongs to the installation itself. */
  userId?: string | null;
  imageRef?: string;
  /** Continuous auto-deploy: the app follows its branch on its own. */
  deployOnPush?: boolean;
}

export interface AppGroupComponent extends AppSummary {
  isPrimary?: boolean;
}

export interface AppGroup {
  id: string;
  type: 'standalone' | 'composed';
  name: string;
  slug: string;
  status: string;
  category: string;
  clusterId: string;
  url?: string;
  catalogSlug?: string;
  catalogInstallId?: string;
  primaryComponentId?: string;
  componentCount: number;
  replicas?: number | null;
  components: AppGroupComponent[];
}

export interface ResourcesConsequence {
  requests: { cpu: string | null; memory: string | null };
  limits: { cpu: string | null; memory: string | null };
  problem: string | null;
  placement: {
    verdict: 'fits' | 'buys' | 'proposes' | 'nothing-hosts' | 'unknown';
    sentence: string;
    why: string | null;
    largest: {
      shape: string | null;
      cpuMillicores: number;
      memoryMi: number;
    } | null;
  };
}

export interface ResourceProposal {
  containerName: string;
  currentRequests: { cpu: string | null; memory: string | null };
  currentLimits: { cpu: string | null; memory: string | null };
  reasons: { kind: 'oom' | 'near-limit' | 'above-request'; sentence: string }[];
  consequence: ResourcesConsequence;
  restart: string;
  configurationNote: string | null;
  diagnosisId: string | null;
}

export interface ResourceProposalAnswer {
  proposal: ResourceProposal | null;
  usageRead: boolean;
}

export interface AppRuntime {
  appId: string;
  deploymentName: string;
  namespace: string;
  replicas: {
    desired?: number;
    ready?: number;
    available?: number;
    unavailable?: number;
    updated?: number;
  };
  containers: Array<{
    name: string;
    image: string;
    requests: { cpu?: string; memory?: string };
    limits: { cpu?: string; memory?: string };
    usage?: { cpu?: string; memory?: string };
  }>;
  /** Replicas no node has room for yet, and what scaling does about it. */
  waitingForRoom?: {
    replicas: number;
    says: string;
    verdict: string | null;
  } | null;
  restartPending?: { changes: string[] } | null;
  pods?: Array<{
    name: string;
    node: string | null;
    role: 'master' | 'worker' | null;
    serverType: string | null;
    region: string | null;
    phase: string;
    ready: boolean;
  }>;
}

/**
 * The variables of one application, as the API reports them.
 *
 * `data` carries the plain values and, for every configured sensitive key, the
 * mask `****` — there is no call anywhere that returns the real one. A key in
 * `pendingKeys` is declared and NOT yet delivered: it appears in neither `data`
 * nor `sensitiveKeys`, because there is nothing to mask.
 */
export interface AppVariablesView {
  name: string;
  data: Record<string, string>;
  sensitiveKeys: string[];
  pendingKeys: string[];
}

export interface AppLogEntry {
  timestamp: string;
  level?: string;
  message: string;
  namespace?: string;
  app?: string;
  pod?: string;
  container?: string;
}

export interface AppLogsResponse {
  cluster_id: string;
  count: number;
  logs: AppLogEntry[];
  queried_at: string;
}

export interface CrashDiagnosis {
  id: string;
  applicationId: string;
  podName: string;
  containerName: string | null;
  category: string;
  severity: string;
  title: string;
  explanation: string;
  suggestedAction: Record<string, any>;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AppMetricsResponse {
  app_id: string;
  app_name: string;
  namespace: string;
  cluster_id: string;
  queried_at: string;
  metrics: {
    cpu: {
      usage_cores: number | null;
      requests_cores: number | null;
      limits_cores: number | null;
      utilization_percent: number | null;
    };
    memory: {
      usage_bytes: number | null;
      requests_bytes: number | null;
      limits_bytes: number | null;
      utilization_percent: number | null;
    };
    network: {
      receive_bytes_rate: number | null;
      transmit_bytes_rate: number | null;
    };
    status: {
      replicas_desired: number | null;
      replicas_ready: number | null;
      replicas_unavailable: number | null;
      ready_ratio: number | null;
      up: number | null;
      restart_total: number | null;
      restart_rate_1h: number | null;
    };
    pods: Array<{ phase: string; count: number }>;
    replicas: Array<Record<string, unknown>>;
    health?: { status: string; message?: string } | null;
  };
}

export interface AppTrafficResponse {
  app_id: string;
  app_name: string;
  namespace: string;
  cluster_id: string;
  traefik_service: string | null;
  is_routable: boolean;
  window: string;
  queried_at: string;
  traffic: {
    rate: {
      requests_per_second: number | null;
      requests_in_window: number | null;
    };
    status: {
      rate_2xx: number | null;
      rate_3xx: number | null;
      rate_4xx: number | null;
      rate_5xx: number | null;
      server_error_percent: number | null;
      client_error_percent: number | null;
    };
    latency: {
      p50_seconds: number | null;
      p90_seconds: number | null;
      p95_seconds: number | null;
      p99_seconds: number | null;
      mean_seconds: number | null;
      estimates_are_coarse: boolean;
      bucket_boundaries_seconds: number[];
    };
    by_method: Array<{ method: string; requests_per_second: number | null }>;
    by_status_code: Array<{ code: string; requests_per_second: number | null }>;
  };
}

export interface AppAlert {
  id: string;
  status: string;
  resolved_by?: string | null;
  alertname: string;
  severity: string;
  flui_kind?: string | null;
  summary: string;
  description?: string | null;
  application_id?: string | null;
  application_slug?: string | null;
  namespace?: string | null;
  cluster_id?: string | null;
  node_instance?: string | null;
  starts_at: string;
  ends_at?: string | null;
  last_seen_at: string;
}

export interface AppAlertsResponse {
  alerts: AppAlert[];
  firing: number;
  queried_at: string;
}

export interface AppLogsOptions {
  level?: string;
  tail?: number;
  search?: string;
  pod?: string;
  stream?: string;
  start?: string;
  end?: string;
}

export interface AppDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  catalogInstallId?: string;
  catalogSlug?: string;
  systemProtected?: boolean;
}

/** A v4 uuid, which is what every application id on an installation is. */
const LOOKS_LIKE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeleteTarget {
  kind: 'standalone' | 'composed';
  name: string;
  slug: string;
  status: string;
  appId?: string;
  catalogInstallId?: string;
  /**
   * Any component of the group. The removal preview is asked per application
   * and answers for the whole install, so one component is enough — a composed
   * target has no application id of its own.
   */
  previewApplicationId?: string;
}

export interface RemovalPreviewVolume {
  name: string;
  namespace: string;
  applicationName: string;
  requested: string | null;
  sizeLabel: string;
  attributedBy: string;
}

export interface RemovalPreview {
  removes: 'catalog-install' | 'application';
  label: string;
  applications: { id: string; name: string; slug: string }[];
  volumes: RemovalPreviewVolume[];
  totalBytes: number;
  totalLabel: string;
  volumesKnown: boolean;
  dataWarning: string | null;
  note?: string;
}

export interface UninstallResult {
  id: string;
  status: string;
}

export interface DeleteAppResult {
  operation: {
    id: string;
    status: string;
    totalSteps: number;
    operationType: string;
  };
}

export interface AppBuild {
  id: string;
  applicationId: string | null;
  provider: 'IN_CLUSTER_AGENT' | 'GITHUB_ACTIONS' | 'RAILPACK' | 'DOCKERFILE';
  status:
    | 'PENDING'
    | 'CLONING'
    | 'ANALYZING'
    | 'BUILDING'
    | 'PUSHING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';
  branch: string;
  commitSha?: string;
  imageRef?: string;
  externalRunId?: string;
  externalUrl?: string;
  logsUrl?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationRelease {
  applicationId: string;
  operationId: string;
  status: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';
  imageRef?: string | null;
  previousImageRef?: string | null;
  buildId?: string | null;
  failureReason?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface AvailableVersion {
  tag: string;
  imageRef: string;
  versionId?: number;
  allTags?: string[];
  isCurrentlyDeployed: boolean;
  createdAt?: string;
  digest?: string;
  deployHint?: string;
  platforms?: string[];
  lastRelease?: ApplicationRelease | null;
  releaseCount: number;
  isLatestRelease: boolean;
}

export interface AvailableVersionsResponse {
  sourceType: string;
  currentImageRef: string | null;
  versions: AvailableVersion[];
  nextPage: number | null;
  allowedPatterns: string[] | null;
}

export interface AppEndpoint {
  id: string;
  clusterId: string;
  applicationId?: string;
  endpointType: string;
  hostnameMode: string;
  fqdn: string;
  tlsEnabled: boolean;
  certificateStatus?: string;
  certificateMessage?: string;
  reconciliationStatus?: string;
  errorMessage?: string;
}

export class CliAppService {
  private readonly apiClient: ApiClient;
  private readonly clusterId: string;

  constructor(apiClient: ApiClient, clusterId: string) {
    this.apiClient = apiClient;
    this.clusterId = clusterId;
  }

  static async create(clusterId: string): Promise<CliAppService> {
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();

    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey });
    return new CliAppService(apiClient, clusterId);
  }

  async listApps(): Promise<AppSummary[]> {
    return this.apiClient.get<AppSummary[]>(
      `/clusters/${this.clusterId}/applications`,
    );
  }

  async listAppGroups(): Promise<AppGroup[]> {
    return this.apiClient.get<AppGroup[]>(
      `/clusters/${this.clusterId}/applications/grouped`,
    );
  }

  async getAppByName(name: string): Promise<AppSummary> {
    const apps = await this.listApps();
    const app = apps.find(
      (a) =>
        a.name.toLowerCase() === name.toLowerCase() ||
        a.slug.toLowerCase() === name.toLowerCase(),
    );
    if (app) return app;
    return appOfInstall(apps, name);
  }

  // Group-aware: a composed catalog install matches by its bundle name/slug (or
  // any component's) and removal uninstalls the whole bundle; the flat listing
  // only carries components, so name/slug lookup there can't see the bundle.
  async resolveDeleteTarget(name: string): Promise<DeleteTarget> {
    /**
     * An id is looked up on its own, outside the cluster.
     *
     * Everything else here resolves inside the current cluster, which is the
     * right shape for a name — but it means an application whose cluster has
     * been deleted can never be named at all, and those are exactly the ones an
     * operator needs to remove. The id is the one handle that still works when
     * the machines are gone.
     */
    if (LOOKS_LIKE_ID.test(name)) {
      const app = await this.apiClient.get<AppSummary>(`/applications/${name}`);
      return {
        kind: 'standalone',
        name: app.name,
        slug: app.slug,
        status: app.status,
        appId: app.id,
        previewApplicationId: app.id,
      };
    }

    const groups = await this.listAppGroups();
    const q = name.toLowerCase();

    const group = groups.find(
      (g) => g.name.toLowerCase() === q || g.slug.toLowerCase() === q,
    );
    if (group) return this.toDeleteTarget(group);

    for (const g of groups) {
      const hit = g.components.some(
        (c) => c.name.toLowerCase() === q || c.slug.toLowerCase() === q,
      );
      if (hit) return this.toDeleteTarget(g);
    }

    throw new Error(`App "${name}" not found in cluster.`);
  }

  private toDeleteTarget(group: AppGroup): DeleteTarget {
    if (group.type === 'composed') {
      return {
        kind: 'composed',
        name: group.name,
        slug: group.slug,
        status: group.status,
        catalogInstallId: group.catalogInstallId ?? group.id,
        previewApplicationId:
          group.components.find((c) => c.isPrimary)?.id ??
          group.components[0]?.id,
      };
    }
    const app =
      group.components.find((c) => c.isPrimary) ?? group.components[0];
    return {
      kind: 'standalone',
      name: group.name,
      slug: group.slug,
      status: group.status,
      appId: app?.id,
      previewApplicationId: app?.id,
    };
  }

  async getRuntime(appId: string): Promise<AppRuntime> {
    return this.apiClient.get<AppRuntime>(`/applications/${appId}/runtime`);
  }

  async listEndpoints(applicationId?: string): Promise<AppEndpoint[]> {
    const all = await this.apiClient.get<AppEndpoint[]>(
      `/clusters/${this.clusterId}/endpoints`,
    );
    return applicationId
      ? all.filter((e) => e.applicationId === applicationId)
      : all;
  }

  /**
   * Per application, not per cluster. The cluster-wide route reads the logs of
   * everything running on the cluster and now carries the `infrastructure`
   * section, which no `operator` holds — so `flui app logs` asked for a right it
   * did not need and was broken for every non-administrator. This
   * route carries `AppAccessGuard` instead: it asks whose application it is,
   * which is the question the command was always really posing.
   *
   * Namespace and workload come off the application record, so the
   * `--namespace` flag has nothing left to override — the route derives what
   * the flag used to say it auto-detected.
   */
  async getLogs(
    appId: string,
    options: AppLogsOptions,
  ): Promise<AppLogsResponse> {
    const params = new URLSearchParams();
    if (options.level) params.append('level', options.level);
    if (options.tail) params.append('tail', String(options.tail));
    if (options.search) params.append('search', options.search);
    if (options.pod) params.append('pod', options.pod);
    if (options.stream) params.append('stream', options.stream);
    if (options.start) params.append('start', options.start);
    if (options.end) params.append('end', options.end);

    const qs = params.toString();
    const qsSuffix = qs ? `?${qs}` : '';
    return this.apiClient.get<AppLogsResponse>(
      `/observability/applications/${appId}/logs${qsSuffix}`,
    );
  }

  /**
   * One application, in full.
   *
   * The cluster listing answers with a reduced view — `deployOnPush` is not in
   * it — so a policy read off the list reports "off" for a field that was never
   * sent. Anything that has to be sure asks here.
   */
  async getApp(appId: string): Promise<AppSummary> {
    return this.apiClient.get<AppSummary>(`/applications/${appId}`);
  }

  /**
   * Turn continuous auto-deploy on or off for a git-build application.
   *
   * With it on, the platform rolls out the newest successful build of the
   * branch and a version chosen by hand is overwritten by the next reconcile —
   * so this is the switch to reach for before pinning an older image.
   */
  async setDeployOnPush(appId: string, enabled: boolean): Promise<AppSummary> {
    return this.apiClient.patch<AppSummary>(`/applications/${appId}`, {
      deployOnPush: enabled,
    });
  }

  async scale(appId: string, replicas: number): Promise<AppRuntime> {
    return this.apiClient.patch<AppRuntime>(`/applications/${appId}/replicas`, {
      replicas,
    });
  }

  async getVariables(appId: string): Promise<AppVariablesView> {
    return this.apiClient.get<AppVariablesView>(
      `/variables/applications/${appId}`,
    );
  }

  /**
   * Deliver one sensitive value.
   *
   * The value goes in the request BODY and nowhere else — not the path, not a
   * query string, not a log line. It is a merge, so the other keys of the app
   * are untouched, and the response is the ordinary masked view: nothing here
   * can read a value back, including the one just sent.
   */
  async setSensitiveVariable(
    appId: string,
    key: string,
    value: string,
  ): Promise<AppVariablesView> {
    return this.apiClient.put<AppVariablesView>(
      `/variables/applications/${appId}?type=sensitive`,
      { data: { [key]: value } },
    );
  }

  /** Record a sensitive key as awaiting a value, carrying no value at all. */
  async requestSensitiveVariable(
    appId: string,
    key: string,
  ): Promise<AppVariablesView> {
    return this.apiClient.put<AppVariablesView>(
      `/variables/applications/${appId}?type=sensitive`,
      { data: {}, requestKeys: [key] },
    );
  }

  async restart(appId: string): Promise<void> {
    return this.apiClient.post<void>(`/applications/${appId}/restart`);
  }

  async stop(appId: string): Promise<void> {
    return this.apiClient.post<void>(`/applications/${appId}/stop`);
  }

  async start(appId: string): Promise<void> {
    return this.apiClient.post<void>(`/applications/${appId}/start`);
  }

  async getCrashes(appId: string): Promise<CrashDiagnosis[]> {
    return this.apiClient.get<CrashDiagnosis[]>(
      `/applications/${appId}/crash-diagnoses`,
    );
  }

  async getCrash(appId: string, id: string): Promise<CrashDiagnosis> {
    return this.apiClient.get<CrashDiagnosis>(
      `/applications/${appId}/crash-diagnoses/${id}`,
    );
  }

  async dismissCrash(appId: string, id: string): Promise<CrashDiagnosis> {
    return this.apiClient.post<CrashDiagnosis>(
      `/applications/${appId}/crash-diagnoses/${id}/dismiss`,
    );
  }

  async applyCrash(appId: string, id: string): Promise<CrashDiagnosis> {
    return this.apiClient.post<CrashDiagnosis>(
      `/applications/${appId}/crash-diagnoses/${id}/apply`,
    );
  }

  async setResources(
    appId: string,
    change: {
      requests?: { cpu?: string; memory?: string };
      limits?: { cpu?: string; memory?: string };
      containerName?: string;
    },
  ): Promise<AppRuntime> {
    return this.apiClient.patch<AppRuntime>(
      `/applications/${appId}/resources`,
      change,
    );
  }

  async resourceProposal(appId: string): Promise<ResourceProposalAnswer> {
    return this.apiClient.get<ResourceProposalAnswer>(
      `/applications/${appId}/resources/proposal`,
    );
  }

  async applyResourceProposal(appId: string): Promise<ResourceProposalAnswer> {
    return this.apiClient.post<ResourceProposalAnswer>(
      `/applications/${appId}/resources/proposal/apply`,
      {},
    );
  }

  async deferResourceProposal(appId: string): Promise<DeferredAction> {
    return this.apiClient.post<DeferredAction>(
      `/applications/${appId}/resources/proposal/defer`,
      {},
    );
  }

  async clusterMaintenance(clusterId: string): Promise<ClusterMaintenance> {
    return this.apiClient.get<ClusterMaintenance>(
      `/infrastructure/clusters/${clusterId}/maintenance-window`,
    );
  }

  async setClusterMaintenance(
    clusterId: string,
    window: MaintenanceWindow,
  ): Promise<ClusterMaintenance> {
    return this.apiClient.put<ClusterMaintenance>(
      `/infrastructure/clusters/${clusterId}/maintenance-window`,
      window,
    );
  }

  async clearClusterMaintenance(
    clusterId: string,
  ): Promise<ClusterMaintenance> {
    return this.apiClient.delete<ClusterMaintenance>(
      `/infrastructure/clusters/${clusterId}/maintenance-window`,
    );
  }

  async clusterDeferredActions(clusterId: string): Promise<DeferredAction[]> {
    return this.apiClient.get<DeferredAction[]>(
      `/infrastructure/clusters/${clusterId}/deferred-actions`,
    );
  }

  async appMaintenance(appId: string): Promise<AppMaintenanceReading> {
    return this.apiClient.get<AppMaintenanceReading>(
      `/applications/${appId}/maintenance`,
    );
  }

  async setAppMaintenance(
    appId: string,
    body: { mode: 'follow' | 'own' | 'anytime'; window?: MaintenanceWindow },
  ): Promise<AppMaintenanceReading> {
    return this.apiClient.put<AppMaintenanceReading>(
      `/applications/${appId}/maintenance`,
      body,
    );
  }

  async appDeferredActions(appId: string): Promise<DeferredAction[]> {
    return this.apiClient.get<DeferredAction[]>(
      `/applications/${appId}/deferred-actions`,
    );
  }

  async cancelDeferredAction(
    appId: string,
    actionId: string,
  ): Promise<DeferredAction> {
    return this.apiClient.delete<DeferredAction>(
      `/applications/${appId}/deferred-actions/${encodeURIComponent(actionId)}`,
    );
  }

  async resourcesConsequence(
    appId: string,
    change: {
      requests?: { cpu?: string; memory?: string };
      limits?: { cpu?: string; memory?: string };
      containerName?: string;
    },
  ): Promise<ResourcesConsequence> {
    return this.apiClient.post<ResourcesConsequence>(
      `/applications/${appId}/resources/consequence`,
      change,
    );
  }

  async getMetrics(appId: string): Promise<AppMetricsResponse> {
    return this.apiClient.get<AppMetricsResponse>(
      `/observability/applications/${appId}/metrics`,
    );
  }

  async getTraffic(
    appId: string,
    window?: string,
  ): Promise<AppTrafficResponse> {
    const query = window ? `?window=${encodeURIComponent(window)}` : '';
    return this.apiClient.get<AppTrafficResponse>(
      `/observability/applications/${appId}/traffic${query}`,
    );
  }

  async getAlerts(
    appId: string,
    options: { status?: string; limit?: number } = {},
  ): Promise<AppAlertsResponse> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.apiClient.get<AppAlertsResponse>(
      `/observability/applications/${appId}/alerts${query}`,
    );
  }

  async getAppDetail(appId: string): Promise<AppDetail> {
    return this.apiClient.get<AppDetail>(`/applications/${appId}`);
  }

  async uninstall(catalogInstallId: string): Promise<UninstallResult> {
    return this.apiClient.delete<UninstallResult>(
      `/catalog/installs/${catalogInstallId}`,
    );
  }

  /** What the removal takes away, asked before it is asked to take it. */
  async getRemovalPreview(applicationId: string): Promise<RemovalPreview> {
    return this.apiClient.get<RemovalPreview>(
      `/applications/${applicationId}/removal-preview`,
    );
  }

  async deleteApp(appId: string): Promise<DeleteAppResult> {
    return this.apiClient.delete<DeleteAppResult>(`/applications/${appId}`);
  }

  async getInstallStatus(
    catalogInstallId: string,
  ): Promise<{ id: string; status: string; errorMessage?: string }> {
    return this.apiClient.get(`/catalog/installs/${catalogInstallId}`);
  }

  // ── Builds ──────────────────────────────────────────────────────────────

  async listBuilds(appId: string): Promise<AppBuild[]> {
    return this.apiClient.get<AppBuild[]>(`/applications/${appId}/builds`);
  }

  async getLatestBuild(appId: string): Promise<AppBuild | null> {
    try {
      return await this.apiClient.get<AppBuild>(
        `/applications/${appId}/builds/latest`,
      );
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async getBuild(buildId: string): Promise<AppBuild> {
    return this.apiClient.get<AppBuild>(`/applications/builds/${buildId}`);
  }

  async refreshBuild(buildId: string): Promise<AppBuild> {
    return this.apiClient.post<AppBuild>(
      `/applications/builds/${buildId}/refresh`,
    );
  }

  async cancelBuild(buildId: string): Promise<void> {
    return this.apiClient.post<void>(`/applications/builds/${buildId}/cancel`);
  }

  async deployFromBuild(appId: string, buildId: string): Promise<unknown> {
    return this.apiClient.post(
      `/applications/${appId}/builds/${buildId}/deploy`,
    );
  }

  // ── Releases ────────────────────────────────────────────────────────────

  async getCurrentRelease(appId: string): Promise<ApplicationRelease | null> {
    return this.apiClient.get<ApplicationRelease | null>(
      `/applications/${appId}/release`,
    );
  }

  async listReleases(appId: string): Promise<ApplicationRelease[]> {
    const res = await this.apiClient.get<{ releases: ApplicationRelease[] }>(
      `/applications/${appId}/releases`,
    );
    return res.releases;
  }

  // ── Versions / Images ───────────────────────────────────────────────────

  async listAvailableVersions(
    appId: string,
  ): Promise<AvailableVersionsResponse> {
    return this.apiClient.get<AvailableVersionsResponse>(
      `/applications/${appId}/available-versions`,
    );
  }

  async redeployTag(appId: string, tag: string): Promise<unknown> {
    return this.apiClient.post(
      `/image-registry/apps/${appId}/ghcr/${encodeURIComponent(tag)}/deploy`,
    );
  }

  /**
   * Ask an application to run a particular image.
   *
   * The registry route above cannot serve a system application: it refuses
   * anything whose `userId` does not match the caller's, and a system
   * application has no owner at all, so it refuses everyone. This is the route
   * the dashboard's own Deploy button takes.
   */
  async deployImageRef(appId: string, imageRef: string): Promise<unknown> {
    return this.apiClient.post(`/applications/${appId}/deploy`, { imageRef });
  }

  async deleteImageVersion(
    appId: string,
    versionId: number,
    options?: { force?: boolean },
  ): Promise<{ deleted: boolean }> {
    const qs = options?.force ? '?force=true' : '';
    return this.apiClient.delete<{ deleted: boolean }>(
      `/image-registry/apps/${appId}/ghcr/${versionId}${qs}`,
    );
  }

  // ── Volume snapshots ────────────────────────────────────

  async createAppSnapshot(
    appId: string,
    body: {
      volumeName?: string;
      description?: string;
      allowInconsistent?: boolean;
      pause?: boolean;
    } = {},
  ): Promise<SnapshotResponse> {
    return this.apiClient.post<SnapshotResponse>(
      `/applications/${appId}/snapshots`,
      body,
    );
  }

  async appVolumeResizePlan(appId: string): Promise<VolumeResizePlan[]> {
    return this.apiClient.get<VolumeResizePlan[]>(
      `/applications/${appId}/volumes/resize-plan`,
    );
  }

  async resizeAppVolume(
    appId: string,
    volumeName: string,
    sizeGb: number,
  ): Promise<VolumeResizeResult> {
    return this.apiClient.post<VolumeResizeResult>(
      `/applications/${appId}/volumes/${encodeURIComponent(volumeName)}/resize`,
      { sizeGb },
    );
  }

  async listAppSnapshots(appId: string): Promise<SnapshotListResponse> {
    return this.apiClient.get<SnapshotListResponse>(
      `/applications/${appId}/snapshots`,
    );
  }

  async deleteAppSnapshot(
    appId: string,
    snapshotId: string,
  ): Promise<{ operationId: string } | void> {
    return this.apiClient.delete<{ operationId: string }>(
      `/applications/${appId}/snapshots/${encodeURIComponent(snapshotId)}`,
    );
  }

  async listClusterSnapshots(): Promise<SnapshotResponse[]> {
    return this.apiClient.get<SnapshotResponse[]>(
      `/clusters/${this.clusterId}/snapshots`,
    );
  }

  async restoreAppSnapshot(
    appId: string,
    snapshotId: string,
  ): Promise<{ newPvcName: string; sourceSnapshotId: string }> {
    return this.apiClient.post<{
      newPvcName: string;
      sourceSnapshotId: string;
    }>(
      `/applications/${appId}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
      {},
    );
  }

  async swapAppVolume(
    appId: string,
    volumeName: string,
    newClaimName: string,
  ): Promise<unknown> {
    return this.apiClient.post<unknown>(
      `/applications/${appId}/volumes/${encodeURIComponent(volumeName)}/swap`,
      { newClaimName },
    );
  }

  // ── Volume backups (s3-archive sink) ────────────────────────

  async createAppBackup(
    appId: string,
    body: {
      destinationId?: string;
      volumeName?: string;
      description?: string;
      destination?: BackupDestinationInput;
      allowInconsistent?: boolean;
      pause?: boolean;
    },
  ): Promise<BackupResponse> {
    return this.apiClient.post<BackupResponse>(
      `/applications/${appId}/backups`,
      body,
    );
  }

  async deleteAppBackup(
    appId: string,
    exportId: string,
    destination: BackupDestinationInput,
  ): Promise<void> {
    await this.apiClient.delete<void>(
      `/applications/${appId}/backups/${encodeURIComponent(exportId)}`,
      { data: { destination } },
    );
  }

  // ── Scheduled jobs (cron) ────────────────────────────────────

  async listScheduledJobs(appId: string): Promise<ScheduledJob[]> {
    return this.apiClient.get<ScheduledJob[]>(
      `/applications/${appId}/schedules`,
    );
  }

  async createScheduledJob(
    appId: string,
    body: CreateScheduledJobInput,
  ): Promise<ScheduledJob> {
    return this.apiClient.post<ScheduledJob>(
      `/applications/${appId}/schedules`,
      body,
    );
  }

  async updateScheduledJob(
    appId: string,
    name: string,
    body: UpdateScheduledJobInput,
  ): Promise<ScheduledJob> {
    return this.apiClient.patch<ScheduledJob>(
      `/applications/${appId}/schedules/${encodeURIComponent(name)}`,
      body,
    );
  }

  async deleteScheduledJob(appId: string, name: string): Promise<void> {
    await this.apiClient.delete<void>(
      `/applications/${appId}/schedules/${encodeURIComponent(name)}`,
    );
  }

  async triggerScheduledJob(
    appId: string,
    name: string,
  ): Promise<{ jobName: string }> {
    return this.apiClient.post<{ jobName: string }>(
      `/applications/${appId}/schedules/${encodeURIComponent(name)}/trigger`,
    );
  }

  async listScheduledJobRuns(
    appId: string,
    name: string,
  ): Promise<ScheduledJobRun[]> {
    return this.apiClient.get<ScheduledJobRun[]>(
      `/applications/${appId}/schedules/${encodeURIComponent(name)}/runs`,
    );
  }

  async getScheduledJobRunLogs(
    appId: string,
    name: string,
    jobName: string,
  ): Promise<{ jobName: string; logs: string }> {
    return this.apiClient.get<{ jobName: string; logs: string }>(
      `/applications/${appId}/schedules/${encodeURIComponent(name)}/runs/${encodeURIComponent(jobName)}/logs`,
    );
  }

  // ── Gateway (L7 routes + policies) ───────────────────────────

  async listGatewayRoutes(appId: string): Promise<GatewayRoute[]> {
    return this.apiClient.get<GatewayRoute[]>(
      `/applications/${appId}/gateway/routes`,
    );
  }

  async listClusterGatewayRoutes(
    clusterId: string,
  ): Promise<ClusterGatewayRoute[]> {
    return this.apiClient.get<ClusterGatewayRoute[]>(
      `/clusters/${clusterId}/gateway/routes`,
    );
  }

  async addGatewayRoute(
    appId: string,
    body: AddGatewayRouteInput,
  ): Promise<GatewayRoute> {
    return this.apiClient.post<GatewayRoute>(
      `/applications/${appId}/gateway/routes`,
      body,
    );
  }

  async setGatewayPolicy(
    appId: string,
    endpointId: string,
    body: SetGatewayPolicyInput,
  ): Promise<GatewayRoute> {
    return this.apiClient.patch<GatewayRoute>(
      `/applications/${appId}/gateway/routes/${encodeURIComponent(endpointId)}`,
      body,
    );
  }

  async removeGatewayRoute(appId: string, endpointId: string): Promise<void> {
    await this.apiClient.delete<void>(
      `/applications/${appId}/gateway/routes/${encodeURIComponent(endpointId)}`,
    );
  }

  async reconcileGatewayRoute(
    appId: string,
    endpointId: string,
  ): Promise<GatewayRoute & { sync: EndpointSyncOutcome }> {
    return this.apiClient.post<GatewayRoute & { sync: EndpointSyncOutcome }>(
      `/applications/${appId}/gateway/routes/${encodeURIComponent(endpointId)}/reconcile`,
    );
  }

  async getGatewayStatus(appId: string): Promise<GatewayStatus> {
    return this.apiClient.get<GatewayStatus>(
      `/applications/${appId}/gateway/status`,
    );
  }
}

export type CronConcurrencyPolicy = 'Allow' | 'Forbid' | 'Replace';

export interface ScheduledJob {
  name: string;
  resourceName: string;
  schedule: string;
  command: string;
  timezone?: string;
  concurrencyPolicy: CronConcurrencyPolicy;
  enabled: boolean;
  activeRuns: number;
  lastScheduleTime?: string | null;
  lastSuccessfulTime?: string | null;
  createdAt?: string | null;
}

export interface CreateScheduledJobInput {
  name: string;
  schedule: string;
  command: string;
  timezone?: string;
  concurrencyPolicy?: CronConcurrencyPolicy;
  enabled?: boolean;
}

export interface UpdateScheduledJobInput {
  schedule?: string;
  command?: string;
  timezone?: string;
  concurrencyPolicy?: CronConcurrencyPolicy;
  enabled?: boolean;
}

export interface ScheduledJobRun {
  jobName: string;
  status: 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  manual: boolean;
  startTime?: string | null;
  completionTime?: string | null;
}

export type GatewayMinRole = 'viewer' | 'operator' | 'maintainer';

export interface GatewayAuthPolicy {
  sso: boolean;
  minRole?: GatewayMinRole;
}

export interface GatewayRateLimitPolicy {
  average: number;
  burst?: number;
  period?: string;
}

export interface GatewayRoute {
  endpointId: string;
  host: string;
  path: string;
  applicationId: string;
  service: string;
  endpointType: string;
  tlsEnabled: boolean;
  certificateStatus?: string | null;
  certificatePhase?: CertificatePhase;
  auth?: GatewayAuthPolicy | null;
  rateLimit?: GatewayRateLimitPolicy | null;
  allowIps?: string[] | null;
  reconciliationStatus: string;
  errorMessage?: string | null;
}

export interface ClusterGatewayRoute extends GatewayRoute {
  applicationName?: string | null;
  applicationSlug?: string | null;
}

export interface AddGatewayRouteInput {
  host: string;
  path?: string;
  clusterDnsZoneId?: string;
  certificateRequired?: boolean;
  auth?: GatewayAuthPolicy;
  rateLimit?: GatewayRateLimitPolicy;
  allowIps?: string[];
}

export interface SetGatewayPolicyInput {
  path?: string | null;
  auth?: GatewayAuthPolicy | null;
  rateLimit?: GatewayRateLimitPolicy | null;
  allowIps?: string[] | null;
}

export interface GatewayStatus {
  total: number;
  synced: number;
  routes: GatewayRoute[];
}

export interface VolumeResizePlan {
  volumeName: string;
  namespace: string;
  storageClass: string | null;
  current: string | null;
  currentBytes: number;
  canGrow: boolean;
  reason?: string;
}

export interface VolumeResizeResult {
  volumeName: string;
  namespace: string;
  from: string | null;
  to: string;
  outcome: 'applied' | 'restart-required' | 'in-progress';
  restartRequired: boolean;
  message: string;
}

/** GET /applications/:id/snapshots — unlike the cluster-wide list, this one
 *  can report why snapshots aren't available for this app at all. */
export interface SnapshotListResponse {
  supported: boolean;
  reason?: string;
  items: SnapshotResponse[];
}

export interface SnapshotResponse {
  /** Present when the copy may not be consistent (a live database). */
  warning?: string;
  exportId: string;
  sink: 'pvc-clone' | 's3-archive';
  namespace: string;
  sourcePvcName?: string;
  appId?: string;
  sizeGb?: number;
  actualBytes?: number;
  createdAt: string;
  ready: boolean;
  labels: Record<string, string>;
  provider: string;
  providerCapabilities: {
    pvcCloneSupportsCheapRetention: boolean;
    s3ArchiveSupportsCheapRetention: boolean;
    pvcClonePricePerGbMonthEur: number | null;
    s3ArchivePricePerGbMonthEur: number | null;
  };
}

export interface BackupDestinationInput {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  keyPrefix?: string;
}

export interface BackupResponse {
  /** Present when the copy may not be consistent (a live database). */
  warning?: string;
  exportId: string;
  appId: string;
  namespace: string;
  sourcePvcName: string;
  sizeGb: number;
  actualBytes?: number;
  createdAt: string;
  ready: boolean;
  destination: {
    bucket: string;
    endpoint: string;
    region: string;
    keyPrefix?: string;
  };
  provider: string;
  providerCapabilities: SnapshotResponse['providerCapabilities'];
}

/**
 * A catalog install is named by its own slug — the one `flui deploy` prints —
 * and each of its applications by that slug and a suffix. The install slug
 * names its application when it has one, and names the choice when it has more.
 */
export function appOfInstall<T extends { name: string; slug: string }>(
  apps: T[],
  name: string,
): T {
  const prefix = `${name.toLowerCase()}-`;
  const members = apps.filter((a) => a.slug.toLowerCase().startsWith(prefix));
  if (members.length === 1) return members[0];
  if (members.length > 1) {
    throw new Error(
      `"${name}" is an install of ${members.length} apps; name one of them: ${members.map((a) => a.slug).join(', ')}.`,
    );
  }
  throw new Error(`App "${name}" not found in cluster.`);
}

export interface MaintenanceWindow {
  timezone: string;
  slots: { days: string[]; start: string; durationMinutes: number }[];
}

export interface ClusterMaintenance {
  window: MaintenanceWindow | null;
  nextOpening: string | null;
  says: string;
}

export interface AppMaintenanceReading {
  mode: 'follow' | 'own' | 'anytime';
  window: MaintenanceWindow | null;
  nextOpening: string | null;
  says: string;
}

export interface DeferredAction {
  id: string;
  kind: string;
  clusterId: string;
  applicationId: string | null;
  applicationName: string | null;
  requestedBy: string;
  requestedAt: string;
  runAt: string;
  status: string;
  outcome: string | null;
  says: string;
}
