import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface ManagementNetworkMember {
  clusterId: string;
  clusterName: string;
  nodeName: string | null;
  address: string;
  status: 'pending' | 'active' | 'stale';
  lastHandshakeAt: string | null;
  /** Control nodes whose end is up and that have not seen this member recently; absent from older APIs. */
  unreachedFrom?: string[] | null;
  heldOffOverlay?: boolean;
}

export interface ManagementNetworkHubNode {
  address: string;
  endpoint: string | null;
  keyed: boolean;
  nodeId: string | null;
  nodeName: string | null;
  primary: boolean;
  status: 'pending' | 'active' | 'stale';
  membersReached: number;
  membersNotReached: number;
}

export interface OverlayDemotion {
  clusterId: string;
  clusterName: string;
  from: string | null;
  to: string | null;
  changed: boolean;
  held: boolean;
}

export interface ManagementNetwork {
  enabled: boolean;
  source: 'setting' | 'install' | 'default';
  unavailable: string | null;
  hub: { address: string; endpoint: string | null; keyed: boolean } | null;
  /** Every control node's end; absent from older APIs, which only had `hub`. */
  hubs?: ManagementNetworkHubNode[];
  /** Why the control's end could not be set up on the last attempt; absent from older APIs. */
  hubProblem?: string | null;
  /** Something about the control end that works but is set up wrong; absent from older APIs. */
  hubWarning?: string | null;
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

  demote(clusterId: string): Promise<OverlayDemotion> {
    return this.api.post<OverlayDemotion>(
      `/infrastructure/management-network/clusters/${clusterId}/demote`,
      {},
    );
  }

  release(clusterId: string): Promise<OverlayDemotion> {
    return this.api.delete<OverlayDemotion>(
      `/infrastructure/management-network/clusters/${clusterId}/demote`,
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
