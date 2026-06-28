import { ApiClient } from '../api-client';
import { ConfigStorage } from '../config-storage';

export interface NodeSummary {
  id: string;
  serverName: string;
  nodeType: 'master' | 'worker';
  ipAddress: string;
  status: string;
  providerResourceId?: string;
  createdAt: string;
  metadata?: Record<string, any>;
}

export interface AddWorkerResult {
  operation_id: string;
  resource_id: string;
  status: string;
  estimated_duration: string;
  created_at: string;
}

export interface RemoveWorkerResult {
  operation_id: string;
  resource_id: string;
  status: string;
  estimated_duration: string;
  created_at: string;
}

export interface OperationStatus {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  currentStepIndex: number;
  totalSteps: number;
  currentStepProgress: number;
  metadata?: Record<string, any>;
}

export class CliNodeService {
  private readonly apiClient: ApiClient;
  private readonly clusterId: string;

  constructor(apiClient: ApiClient, clusterId: string) {
    this.apiClient = apiClient;
    this.clusterId = clusterId;
  }

  static async create(clusterId: string): Promise<CliNodeService> {
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();

    if (!apiKey) {
      throw new Error('Not logged in. Run `flui auth login` first.');
    }

    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey });
    return new CliNodeService(apiClient, clusterId);
  }

  async listNodes(): Promise<NodeSummary[]> {
    return this.apiClient.get<NodeSummary[]>(
      `/infrastructure/clusters/${this.clusterId}/nodes`,
    );
  }

  async addWorkers(count: number): Promise<AddWorkerResult> {
    return this.apiClient.post<AddWorkerResult>(
      `/infrastructure/clusters/${this.clusterId}/workers`,
      { count },
    );
  }

  async removeWorker(nodeId: string): Promise<RemoveWorkerResult> {
    return this.apiClient.delete<RemoveWorkerResult>(
      `/infrastructure/clusters/${this.clusterId}/workers/${nodeId}`,
      { timeout: 180_000 },
    );
  }

  async getOperationStatus(operationId: string): Promise<OperationStatus> {
    return this.apiClient.get<OperationStatus>(
      `/infrastructure/operations/${operationId}`,
    );
  }
}
