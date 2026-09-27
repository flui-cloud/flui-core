import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface ManagementNetworkMember {
  clusterId: string;
  clusterName: string;
  nodeName: string | null;
  address: string;
  status: 'pending' | 'active' | 'stale';
  lastHandshakeAt: string | null;
}

export interface ManagementNetwork {
  enabled: boolean;
  source: 'setting' | 'install' | 'default';
  unavailable: string | null;
  hub: { address: string; endpoint: string | null; keyed: boolean } | null;
  members: ManagementNetworkMember[];
}

export class ManagementNetworkClient {
  constructor(private readonly api: ApiClient) {}

  static open(): ManagementNetworkClient {
    const storage = new ConfigStorage();
    return new ManagementNetworkClient(
      new ApiClient({
        baseUrl: storage.getApiUrlOrThrow(),
        apiKey: storage.getApiKeyOrThrow(),
      }),
    );
  }

  status(): Promise<ManagementNetwork> {
    return this.api.get<ManagementNetwork>(
      '/infrastructure/management-network',
    );
  }

  set(enabled: boolean): Promise<ManagementNetwork> {
    return this.api.put<ManagementNetwork>(
      '/infrastructure/management-network',
      {
        enabled,
      },
    );
  }
}
