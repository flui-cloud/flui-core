import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface CatalogApp {
  id: string;
  slug: string;
  name: string;
  version: string;
  category: string;
  appKind: string;
  appType: string;
  tags: string[];
  description?: string;
  license?: string;
}

export interface CatalogInstall {
  id: string;
  slug: string;
  displayName: string;
  clusterId: string;
  status: string;
  applicationIds: string[];
  requestedDomain?: string;
  resolvedFqdn?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InstallCatalogAppInput {
  clusterId: string;
  displayName: string;
  domain?: string;
  exposure?: string;
  skipEndpoint?: boolean;
  allowMasterPlacement?: boolean;
  userInputs?: Record<string, string>;
  envOverrides?: Record<string, string>;
}

/**
 * Installing from the catalog existed on the API and on a screen, and nowhere a
 * script could reach — so putting an application on a cluster was a click, and
 * rebuilding an instance was a person repeating clicks in order.
 */
export class CatalogClient {
  private readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  static fromConfig(): CatalogClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Not logged in. Run `flui auth login` first or check API key.',
      );
    }
    return new CatalogClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  async list(query?: {
    search?: string;
    category?: string;
  }): Promise<CatalogApp[]> {
    const params = new URLSearchParams();
    if (query?.search) params.set('search', query.search);
    if (query?.category) params.set('category', query.category);
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return this.api.get<CatalogApp[]>(`/catalog${suffix}`);
  }

  /** The building blocks, which `/catalog` hides because they are dependencies. */
  async listBuildingBlocks(): Promise<CatalogApp[]> {
    return this.api.get<CatalogApp[]>('/catalog/building-blocks');
  }

  async install(
    slug: string,
    input: InstallCatalogAppInput,
  ): Promise<CatalogInstall> {
    return this.api.post<CatalogInstall>(
      `/catalog/${encodeURIComponent(slug)}/install`,
      input,
    );
  }

  async getInstall(id: string): Promise<CatalogInstall> {
    return this.api.get<CatalogInstall>(
      `/catalog/installs/${encodeURIComponent(id)}`,
    );
  }
}
