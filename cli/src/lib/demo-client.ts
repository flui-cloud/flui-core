import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface DemoStatus {
  enabled: boolean;
  state: string;
  provisionMode: string;
  windowOpen: boolean;
  current: {
    clusterId: string | null;
    provider: string | null;
    ip: string | null;
  };
  activeMigration: { id: string; status: string | null } | null;
  cycleCount: number;
  lastCycleAt: string | null;
  lastCycleDurationMs: number | null;
  lastError: string | null;
  counters: {
    served: number;
    failed: number;
    lostDuringMigration: number;
    total: number;
    successRatePct: number | null;
    lastProbeAt: string | null;
    lastProbeOk: boolean | null;
  };
  ts: string;
}

export interface DemoConfigInput {
  appId?: string;
  dbAppId?: string;
  clusterAId?: string;
  clusterBId?: string;
  probeUrl?: string;
  probeIntervalMs?: number;
  intervalMinutes?: number;
  drainMinutes?: number;
  stagingMode?: string;
}

/**
 * Client for the self-running cross-provider migration demo: one app looped
 * between two workload clusters, with an honest served/lost counter measured by
 * the master probing the app's public URL. Status is public; config is admin.
 */
export class DemoClient {
  constructor(private readonly api: ApiClient) {}

  static fromConfig(): DemoClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      throw new Error('Not logged in. Run `flui auth login` first.');
    }
    return new DemoClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  status(): Promise<DemoStatus> {
    return this.api.get('/demo/status');
  }

  getConfig(): Promise<Record<string, unknown>> {
    return this.api.get('/demo/admin/config');
  }

  configure(input: DemoConfigInput): Promise<Record<string, unknown>> {
    return this.api.put('/demo/admin/config', input);
  }

  enable(): Promise<Record<string, unknown>> {
    return this.api.post('/demo/admin/enable');
  }

  disable(): Promise<Record<string, unknown>> {
    return this.api.post('/demo/admin/disable');
  }

  trigger(): Promise<{ triggered: true }> {
    return this.api.post('/demo/admin/trigger');
  }

  reset(): Promise<Record<string, unknown>> {
    return this.api.post('/demo/admin/reset');
  }

  resetCounters(): Promise<{ ok: true }> {
    return this.api.post('/demo/admin/reset-counters');
  }
}
