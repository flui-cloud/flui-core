import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface BackupDestination {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix?: string;
  encryptionMode?: string;
  forcePathStyle?: boolean;
  useSse?: boolean;
  usableForEtcdL1?: boolean;
  costPerGbMonthCents?: number;
  health?: string;
  usageBytes?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateBackupDestinationInput {
  name: string;
  provider:
    | 'hetzner_object_storage'
    | 'scaleway_object_storage'
    | 'minio'
    | 'generic_s3';
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix?: string;
  accessKey: string;
  secretKey: string;
  encryptionMode?: 'flui_managed' | 'byo_passphrase' | 'none';
  encryptionPassphrase?: string;
  forcePathStyle?: boolean;
  useSse?: boolean;
  usableForEtcdL1?: boolean;
  costPerGbMonthCents?: number;
}

export interface BackupPolicy {
  id: string;
  name: string;
  clusterId: string;
  scope: string;
  profile: string;
  engineClass?: string;
  enabled?: boolean;
  status?: string;
  cronSchedule?: string;
  schedule?: string;
  retentionDays?: number;
  scopeSelector?: {
    applicationIds?: string[];
    namespaces?: string[];
    [key: string]: unknown;
  };
  destinations?: Array<{
    destinationId: string;
    role: string;
    priority?: number;
  }>;
  metadata?: {
    platform?: {
      recipient?: string;
      heartbeat?: { url?: string };
    };
    [key: string]: unknown;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface CreatePolicyInput {
  name: string;
  clusterId: string;
  scope: string;
  profile: string;
  engineClass?: 'volume' | 'database' | 'platform';
  /** The API's field is cronSchedule — see CreateBackupPolicyDto. */
  cronSchedule?: string;
  retentionDays?: number;
  retentionMaxCopies?: number;
  enabled?: boolean;
  destinations: Array<{
    destinationId: string;
    role: 'primary' | 'replica';
    priority?: number;
  }>;
  scopeSelector?: Record<string, any>;
}

export interface BackupJob {
  id: string;
  policyId: string;
  clusterId?: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  finishedAt?: string;
  bytesTransferred?: number;
  errorMessage?: string;
}

export interface RestoreJob {
  id: string;
  status: string;
  artifactId: string;
  sourceDestinationId: string;
  targetClusterId: string;
  targetKind: string;
  strategy?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export class BackupClient {
  private readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  static fromConfig(): BackupClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Not logged in. Run `flui auth login` first or check API key.',
      );
    }
    return new BackupClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
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

  async createPolicy(input: CreatePolicyInput): Promise<BackupPolicy> {
    return this.api.post('/backup-policies', input);
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

  async createRestore(input: {
    artifactId: string;
    sourceDestinationId: string;
    targetClusterId: string;
    targetKind: string;
    targetSelector?: Record<string, any>;
    strategy?: string;
  }): Promise<RestoreJob> {
    return this.api.post('/restore-jobs', input);
  }

  async listRestores(): Promise<RestoreJob[]> {
    return this.api.get('/restore-jobs');
  }

  async getRestore(id: string): Promise<RestoreJob> {
    return this.api.get(`/restore-jobs/${id}`);
  }
}
