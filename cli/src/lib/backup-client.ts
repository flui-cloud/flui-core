import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';
import {
  BackupDestination,
  CreateBackupDestinationInput,
  BackupPolicy,
  BackupArtifact,
  CreatePolicyInput,
  BackupJob,
  RestoreJob,
  QuickSetupOptions,
  QuickSetupInput,
  PlatformBackupLinks,
  BackupPolicyActivity,
  ClusterProtection,
  ProtectClusterInput,
  BeforeDeployOption,
  VeleroFootprint,
} from './backup-client.types';

export * from './backup-client.types';

export class BackupClient {
  private readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  static fromConfig(): BackupClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKeyOrThrow();
    return new BackupClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  // ─── Quick setup ─────────────────────────────────────────────────────────

  /**
   * What one-click setup would do on this cluster, and whether it can.
   *
   * `ready: false` with a reason rather than an error: "Scaleway is not
   * connected yet" is a thing to go and fix, not a failure of the question.
   */
  async getSetupOptions(clusterId: string): Promise<QuickSetupOptions> {
    return this.api.get(`/clusters/${clusterId}/backups/setup-options`);
  }

  async startQuickSetup(
    clusterId: string,
    input: QuickSetupInput,
  ): Promise<{ operationId?: string; policyId?: string }> {
    return this.api.post(`/clusters/${clusterId}/backups/quick-setup`, input);
  }

  // ─── Cluster protection ──────────────────────────────────────────────────

  async protectCluster(
    clusterId: string,
    input: ProtectClusterInput,
  ): Promise<{ operationId: string; protection: ClusterProtection }> {
    return this.api.post(`/clusters/${clusterId}/backups/protection`, input);
  }

  async getClusterProtection(clusterId: string): Promise<ClusterProtection> {
    return this.api.get(`/clusters/${clusterId}/backups/protection`);
  }

  async stopClusterProtection(
    clusterId: string,
  ): Promise<{ stopped: boolean }> {
    return this.api.delete(`/clusters/${clusterId}/backups/protection`);
  }

  async setBeforeDeploy(
    applicationId: string,
    input: { enabled: boolean; required?: boolean },
  ): Promise<BeforeDeployOption> {
    return this.api.put(
      `/applications/${applicationId}/backup-before-deploy`,
      input,
    );
  }

  // ─── Destinations ────────────────────────────────────────────────────────

  async listDestinations(): Promise<BackupDestination[]> {
    return this.api.get('/backup-destinations');
  }

  async getDestination(id: string): Promise<BackupDestination> {
    return this.api.get(`/backup-destinations/${id}`);
  }

  async createDestination(
    input: CreateBackupDestinationInput,
  ): Promise<BackupDestination> {
    return this.api.post('/backup-destinations', input);
  }

  async testDestination(
    id: string,
  ): Promise<{ healthy: boolean; error?: string }> {
    return this.api.post(`/backup-destinations/${id}/test`);
  }

  async setDestinationCost(
    id: string,
    costPerGbMonthCents: number | null,
  ): Promise<BackupDestination> {
    return this.api.patch(`/backup-destinations/${id}/cost`, {
      costPerGbMonthCents,
    });
  }

  async refreshDestinationUsage(id: string): Promise<{ ok: boolean }> {
    return this.api.post(`/backup-destinations/${id}/refresh-usage`);
  }

  async deleteDestination(id: string): Promise<{ ok: boolean }> {
    return this.api.delete(`/backup-destinations/${id}`);
  }

  // ─── Policies ────────────────────────────────────────────────────────────

  async listPolicies(): Promise<BackupPolicy[]> {
    return this.api.get('/backup-policies');
  }

  async listPoliciesForCluster(clusterId: string): Promise<BackupPolicy[]> {
    return this.api.get(`/backup-policies/cluster/${clusterId}`);
  }

  async getPolicy(id: string): Promise<BackupPolicy> {
    return this.api.get(`/backup-policies/${id}`);
  }

  async getPolicyActivity(
    id: string,
    limit?: number,
  ): Promise<BackupPolicyActivity> {
    const query = limit ? `?limit=${limit}` : '';
    return this.api.get(
      `/backup-policies/${encodeURIComponent(id)}/activity${query}`,
    );
  }

  async listPolicyActivity(): Promise<BackupPolicyActivity[]> {
    return this.api.get('/backup-policies/activity');
  }

  /** Every backup recorded for one application or one cluster. */
  async listArtifacts(filter: {
    applicationId?: string;
    clusterId?: string;
  }): Promise<BackupArtifact[]> {
    const params = new URLSearchParams();
    if (filter.applicationId) params.set('applicationId', filter.applicationId);
    if (filter.clusterId) params.set('clusterId', filter.clusterId);
    return this.api.get(`/backup-artifacts?${params.toString()}`);
  }

  async createPolicy(input: CreatePolicyInput): Promise<BackupPolicy> {
    return this.api.post('/backup-policies', input);
  }

  /**
   * Its own endpoint because the order differs: pgBackRest is configured and
   * proven before the policy row is written, so a failure is the answer to
   * this call rather than a failed job hours later.
   */
  async updatePolicyOptions(
    id: string,
    options: {
      pauseDuringCopy?: boolean;
      excludeVolumes?: string[];
      keepMonthly?: boolean;
    },
  ): Promise<BackupPolicy> {
    return this.api.patch(`/backup-policies/${id}/options`, options);
  }

  async enableDatabase(input: CreatePolicyInput): Promise<BackupPolicy> {
    return this.api.post('/backup-policies/enable-database', input);
  }

  async pausePolicy(id: string): Promise<BackupPolicy> {
    return this.api.post(`/backup-policies/${id}/pause`);
  }

  async setPlatformConfig(
    policyId: string,
    cfg: { recipient: string; heartbeatUrl?: string },
  ): Promise<BackupPolicy> {
    return this.api.post(`/backup-policies/${policyId}/platform-config`, cfg);
  }

  async resumePolicy(id: string): Promise<BackupPolicy> {
    return this.api.post(`/backup-policies/${id}/resume`);
  }

  async deletePolicy(id: string): Promise<{ ok: boolean }> {
    return this.api.delete(`/backup-policies/${id}`);
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────

  async runJobForPolicy(policyId: string): Promise<BackupJob> {
    return this.api.post('/backup-jobs', { policyId });
  }

  async platformBackupLinks(jobId?: string): Promise<PlatformBackupLinks> {
    const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return this.api.get(`/backup-artifacts/platform/download${query}`);
  }

  async getJob(id: string): Promise<BackupJob> {
    return this.api.get(`/backup-jobs/${id}`);
  }

  async listJobsForCluster(clusterId: string): Promise<BackupJob[]> {
    return this.api.get(`/backup-jobs/cluster/${clusterId}`);
  }

  // ─── Restore ─────────────────────────────────────────────────────────────

  async previewRestore(input: {
    artifactId: string;
    sourceDestinationId: string;
  }): Promise<Record<string, any>> {
    return this.api.post('/restore-jobs/preview', input);
  }

  async listRestores(): Promise<RestoreJob[]> {
    return this.api.get('/restore-jobs');
  }

  async getRestore(id: string): Promise<RestoreJob> {
    return this.api.get(`/restore-jobs/${id}`);
  }

  // ─── Retired cluster-backup engine ───────────────────────────────────────

  async getVeleroFootprint(clusterId: string): Promise<VeleroFootprint> {
    return this.api.get(`/clusters/${clusterId}/backups/velero`);
  }

  async uninstallVelero(
    clusterId: string,
  ): Promise<{ operationId: string; alreadyRunning: boolean }> {
    return this.api.post(`/clusters/${clusterId}/backups/velero/uninstall`, {});
  }
}
