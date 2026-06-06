import { Injectable } from '@nestjs/common';
import axios from 'axios';

interface OpenAiModelsResponse {
  data?: Array<{ id: string }>;
}

@Injectable()
export class InferenceClientService {
  async listModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const response = await axios.get<OpenAiModelsResponse>(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });
    return (response.data?.data ?? []).map((m) => m.id);
  }
}
