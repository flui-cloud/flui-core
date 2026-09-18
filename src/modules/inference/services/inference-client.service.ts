import { Injectable } from '@nestjs/common';
import { guardedRequest } from '../../../common/net/egress-guard';
import { filterAssistantModels } from '../utils/model-filter.util';

interface OpenAiModelsResponse {
  data?: Array<{ id: string }>;
}

@Injectable()
export class InferenceClientService {
  async listModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    // Guarded: `baseUrl` is a field any authenticated account can set, and this
    // call is made from inside the cluster.
    const response = await guardedRequest<OpenAiModelsResponse>({
      method: 'GET',
      url,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });
    const ids = (response.data?.data ?? []).map((m) => m.id);
    return filterAssistantModels(ids);
  }
}
