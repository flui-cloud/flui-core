import { ApiClient } from '../api-client';
import { ConfigStorage } from '../config-storage';

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
  components: AppGroupComponent[];
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

export interface AppLogsOptions {
  app?: string;
  namespace?: string;
  level?: string;
  tail?: number;
  search?: string;
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

export interface DeleteTarget {
  kind: 'standalone' | 'composed';
  name: string;
  slug: string;
  status: string;
  appId?: string;
  catalogInstallId?: string;
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
    const apiKey = configStorage.getApiKey();

    if (!apiKey) {
      throw new Error('Not logged in. Run `flui auth login` first.');
    }

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
    if (!app) {
      throw new Error(`App "${name}" not found in cluster.`);
    }
    return app;
  }

  // Group-aware: a composed catalog install matches by its bundle name/slug (or
  // any component's) and removal uninstalls the whole bundle; the flat listing
  // only carries components, so name/slug lookup there can't see the bundle.
  async resolveDeleteTarget(name: string): Promise<DeleteTarget> {
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

  async getLogs(options: AppLogsOptions): Promise<AppLogsResponse> {
    const params = new URLSearchParams();
    if (options.app) params.append('app', options.app);
    if (options.namespace) params.append('namespace', options.namespace);
    if (options.level) params.append('level', options.level);
    if (options.tail) params.append('tail', String(options.tail));
    if (options.search) params.append('search', options.search);

    const qs = params.toString();
    const qsSuffix = qs ? `?${qs}` : '';
    return this.apiClient.get<AppLogsResponse>(
      `/observability/clusters/${this.clusterId}/apps/logs${qsSuffix}`,
    );
  }

  async scale(appId: string, replicas: number): Promise<AppRuntime> {
    return this.apiClient.patch<AppRuntime>(`/applications/${appId}/replicas`, {
      replicas,
    });
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

  async getMetrics(appId: string): Promise<AppMetricsResponse> {
    return this.apiClient.get<AppMetricsResponse>(
      `/applications/${appId}/metrics`,
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
    body: { volumeName?: string; description?: string } = {},
  ): Promise<SnapshotResponse> {
    return this.apiClient.post<SnapshotResponse>(
      `/applications/${appId}/snapshots`,
      body,
    );
  }

  async listAppSnapshots(appId: string): Promise<SnapshotResponse[]> {
    return this.apiClient.get<SnapshotResponse[]>(
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
      volumeName?: string;
      description?: string;
      destination: BackupDestinationInput;
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
}

export interface SnapshotResponse {
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
