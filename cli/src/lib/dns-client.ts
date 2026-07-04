import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export type DnsProviderName = 'hetzner' | 'scaleway' | 'none';
export type DnsReplicaStatus =
  | 'pending'
  | 'populating'
  | 'active'
  | 'degraded'
  | 'disabled';

export interface DnsReplica {
  id: string;
  dnsZoneId: string;
  dnsProvider: DnsProviderName;
  providerZoneId: string;
  status: DnsReplicaStatus;
  lastReconciledAt?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DnsZone {
  id: string;
  providerZoneId: string;
  zoneName: string;
  dnsProvider: DnsProviderName;
  description?: string;
  recordTtlSeconds: number;
  replicas: DnsReplica[];
  createdAt: string;
  updatedAt: string;
}

export interface ReplicaDiffReport {
  provider: DnsProviderName;
  providerZoneId: string;
  created: number;
  updated: number;
  orphansDeleted: number;
  mismatches: Array<{
    name: string;
    type: string;
    expected: string;
    actual: string;
  }>;
  errors: string[];
}

export interface RegisterReplicaInput {
  dnsProvider: DnsProviderName;
  providerZoneId?: string;
}

/**
 * Client for dual-provider DNS redundancy. A logical zone (`/dns/zones`) can be
 * published on additional providers as replicas; every record Flui writes fans
 * out to each active replica, and a cron reconciles them from Flui state.
 */
export class DnsClient {
  private readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  static fromConfig(): DnsClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Not logged in. Run `flui auth login` first or check API key.',
      );
    }
    return new DnsClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  async listZones(): Promise<DnsZone[]> {
    return this.api.get('/dns/zones');
  }

  async listReplicas(zoneId: string): Promise<DnsReplica[]> {
    return this.api.get(`/dns/zones/${zoneId}/replicas`);
  }

  async registerReplica(
    zoneId: string,
    input: RegisterReplicaInput,
  ): Promise<DnsReplica> {
    return this.api.post(`/dns/zones/${zoneId}/replicas`, input);
  }

  async populateReplica(
    zoneId: string,
    replicaId: string,
  ): Promise<ReplicaDiffReport> {
    return this.api.post(`/dns/zones/${zoneId}/replicas/${replicaId}/populate`);
  }

  async verifyReplica(
    zoneId: string,
    replicaId: string,
  ): Promise<ReplicaDiffReport> {
    return this.api.post(`/dns/zones/${zoneId}/replicas/${replicaId}/verify`);
  }

  async disableReplica(zoneId: string, replicaId: string): Promise<DnsReplica> {
    return this.api.post(`/dns/zones/${zoneId}/replicas/${replicaId}/disable`);
  }

  async enableReplica(zoneId: string, replicaId: string): Promise<DnsReplica> {
    return this.api.post(`/dns/zones/${zoneId}/replicas/${replicaId}/enable`);
  }

  async removeReplica(zoneId: string, replicaId: string): Promise<void> {
    return this.api.delete(`/dns/zones/${zoneId}/replicas/${replicaId}`);
  }
}
