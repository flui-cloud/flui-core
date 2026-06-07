import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../interfaces/chat-completion';

@Injectable()
export class AssistantLlmService {
  async chat(
    endpoint: InferenceEndpoint,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const url = `${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const response = await axios.post<ChatCompletionResponse>(url, request, {
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      timeout: 60000,
    });
    return response.data;
  }
}
