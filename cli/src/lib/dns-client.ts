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

export interface ClusterZoneAssignment {
  id: string;
  dnsZoneId: string;
  dnsZone: { zoneName: string; dnsProvider: DnsProviderName };
  wildcardCertificate: boolean;
  reconciliationStatus: string;
  certificateProvider?: string;
  acmeEmail?: string;
  lastReconciliationAt?: string | null;
  errorMessage?: string | null;
}

export interface AssignZoneInput {
  dnsZoneId: string;
  certificateProvider?: string;
  acmeEmail?: string;
  wildcardCertificate?: boolean;
}

/**
 * The one record that decides whether a newly deployed application answers at
 * once or about a minute later.
 *
 * Every application on a cluster is published at `<slug>.<cluster>.<zone>` and
 * points at the same address, so one wildcard covers all of them — including
 * the ones that do not exist yet, which is the part that matters: a name that
 * already resolves has nothing left to propagate.
 */
export interface ClusterWildcard {
  status: 'published' | 'absent' | 'foreign' | 'unknown' | 'unavailable';
  fqdn: string | null;
  hostnamePattern: string | null;
  expectedValue: string | null;
  actualValue: string | null;
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

  /** The zones a cluster publishes applications under. */
  async listAssignments(clusterId: string): Promise<ClusterZoneAssignment[]> {
    return this.api.get<ClusterZoneAssignment[]>(
      `/clusters/${encodeURIComponent(clusterId)}/dns-zone/list`,
    );
  }

  /**
   * Bind a zone to a cluster, so applications are published under it.
   *
   * Done once per cluster and again at every rebuild, which is why it belongs
   * here and not only on a screen.
   */
  async assignZone(
    clusterId: string,
    input: AssignZoneInput,
  ): Promise<ClusterZoneAssignment> {
    return this.api.post<ClusterZoneAssignment>(
      `/clusters/${encodeURIComponent(clusterId)}/dns-zone`,
      input,
    );
  }

  /**
   * Re-apply what the cluster needs for the zone: the DNS-01 credentials, the
   * issuer solvers covering every assigned zone, and the wildcard record.
   *
   * Returns at once with the assignment in RECONCILING — the cluster work runs
   * in the background, so the answer is a starting point, not an outcome.
   */
  async reconcileAssignment(
    clusterId: string,
    assignmentId: string,
  ): Promise<ClusterZoneAssignment> {
    return this.api.post<ClusterZoneAssignment>(
      `/clusters/${encodeURIComponent(clusterId)}` +
        `/dns-zone/${encodeURIComponent(assignmentId)}/reconcile`,
    );
  }

  /** Whether one record covers every application on this cluster. */
  async getWildcard(
    clusterId: string,
    assignmentId: string,
  ): Promise<ClusterWildcard> {
    return this.api.get<ClusterWildcard>(
      this.wildcardPath(clusterId, assignmentId),
    );
  }

  /** Publish it. Never overwrites a wildcard that points somewhere else. */
  async publishWildcard(
    clusterId: string,
    assignmentId: string,
  ): Promise<ClusterWildcard> {
    return this.api.post<ClusterWildcard>(
      this.wildcardPath(clusterId, assignmentId),
      {},
    );
  }

  private wildcardPath(clusterId: string, assignmentId: string): string {
    return (
      `/clusters/${encodeURIComponent(clusterId)}` +
      `/dns-zone/${encodeURIComponent(assignmentId)}/wildcard`
    );
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
