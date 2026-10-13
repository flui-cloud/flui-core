import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface UsageByModel {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  estimated: number;
}

export type UsageKind = 'visitor' | 'guest' | 'person' | 'platform';

export interface UsageByPerson {
  userId: string | null;
  guest: boolean;
  kind?: UsageKind;
  calls: number;
  tokens: number;
  lastAt: string;
}

export interface UsageByKind {
  kind: UsageKind;
  people: number;
  calls: number;
  tokens: number;
}

export interface UsageReport {
  since: string | null;
  byModel: UsageByModel[];
  byPerson: UsageByPerson[];
  byKind?: UsageByKind[];
}

/**
 * What the instance's inference has cost.
 *
 * One read, because there is one ledger: every surface that talks to a model —
 * the assistant and the console copilots — reaches the provider through the
 * same call point, and that is what writes the rows.
 */
export class InferenceUsageClient {
  constructor(private readonly api: ApiClient) {}

  static fromConfig(): InferenceUsageClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKeyOrThrow();
    return new InferenceUsageClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  async report(days: number): Promise<UsageReport> {
    return this.api.get<UsageReport>(`/inference/usage?days=${days}`);
  }
}
