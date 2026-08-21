import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface ShowcaseItem {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  note: string | null;
  runningSince: string;
  url: string | null;
}

/**
 * The shared, read-only corner of a demo instance. Publishing adds the
 * `showcase` tag the authorization grant already follows — there is one mark,
 * not two.
 */
export class ShowcaseClient {
  private readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  static fromConfig(): ShowcaseClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Not logged in. Run `flui auth login` first or check API key.',
      );
    }
    return new ShowcaseClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  async list(): Promise<ShowcaseItem[]> {
    return this.api.get<ShowcaseItem[]>('/showcase');
  }

  /** `ref` is a slug, a name or an id — whichever is at hand. */
  async publish(ref: string, note?: string): Promise<ShowcaseItem> {
    return this.api.put<ShowcaseItem>(`/showcase/${encodeURIComponent(ref)}`, {
      note,
    });
  }

  async withdraw(ref: string): Promise<void> {
    await this.api.delete(`/showcase/${encodeURIComponent(ref)}`);
  }
}
