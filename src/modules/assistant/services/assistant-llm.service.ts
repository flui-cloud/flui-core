import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { describeError } from '../../shared/utils/error.util';
import { toInferenceError } from './inference-error.util';
import { ModelParamPolicyService } from './model-param-policy.service';
import {
  applyParamAdaptation,
  detectParamAdaptation,
  normalizeAxiosErrorBody,
} from './param-recovery.util';
import {
  ChatCompletionChunk,
  ChatCompletionDelta,
  ChatCompletionDeltaToolCall,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolCall,
} from '../interfaces/chat-completion';

// Enough to reconcile a model that rejects several tuning params one at a time
// (e.g. temperature, then max_tokens); a safety net against a pathological loop.
const MAX_PARAM_RETRIES = 3;

type ToolCallSlot = { id: string; name: string; args: string };

@Injectable()
export class AssistantLlmService {
  private readonly logger = new Logger(AssistantLlmService.name);

  constructor(private readonly paramPolicy: ModelParamPolicyService) {}

  async chat(
    endpoint: InferenceEndpoint,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const url = `${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`;
    return this.send(endpoint, request, async (req) => {
      const response = await axios.post<ChatCompletionResponse>(url, req, {
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
        timeout: 60000,
      });
      return response.data;
    });
  }

  /**
   * Stream an OpenAI-compatible completion: text tokens are pushed to `onDelta`
   * as they arrive, while tool-call fragments are reassembled by index. Returns
   * the fully assembled assistant message so the agent loop can drive on it.
   */
  async chatStream(
    endpoint: InferenceEndpoint,
    request: ChatCompletionRequest,
    onDelta: (text: string) => void,
  ): Promise<ChatCompletionMessage> {
    const url = `${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`;
    return this.send(endpoint, request, async (req) => {
      const response = await axios.post<NodeJS.ReadableStream>(
        url,
        { ...req, stream: true },
        {
          headers: { Authorization: `Bearer ${endpoint.apiKey}` },
          timeout: 60000,
          responseType: 'stream',
        },
      );
      return this.consumeStream(response.data, onDelta);
    });
  }

  /**
   * Runs an inference call and, when the provider rejects a parameter (HTTP 400 naming the
   * offending param), adapts the request per the standard error contract and retries —
   * looping so a model that rejects several params (e.g. temperature AND max_tokens) is
   * reconciled one at a time. Each fix removes/renames a param, so it converges; the
   * attempt cap is a safety net. Provider-agnostic: it reacts to what the API reports.
   *
   * Adaptations learned here are cached per endpoint+model and applied up front, so only
   * the first request to a quirky model pays the failing round-trips.
   */
  private async send<T>(
    endpoint: InferenceEndpoint,
    request: ChatCompletionRequest,
    call: (req: ChatCompletionRequest) => Promise<T>,
  ): Promise<T> {
    let current = this.paramPolicy.apply(endpoint.baseUrl, request);
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(current);
      } catch (error) {
        await normalizeAxiosErrorBody(error);
        const adaptation =
          attempt < MAX_PARAM_RETRIES
            ? detectParamAdaptation(current, error)
            : null;
        if (!adaptation) {
          this.logger.warn(describeError(error, 'Inference request failed'));
          throw toInferenceError(error);
        }
        this.paramPolicy.learn(endpoint.baseUrl, request.model, adaptation);
        this.logger.warn(
          `Provider rejected a parameter, retrying with adjustment — ${describeError(error)}`,
        );
        current = applyParamAdaptation(current, adaptation);
      }
    }
  }

  private async consumeStream(
    stream: NodeJS.ReadableStream,
    onDelta: (text: string) => void,
  ): Promise<ChatCompletionMessage> {
    let buffer = '';
    let content = '';
    const slots = new Map<number, ToolCallSlot>();

    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const delta = this.parseDelta(line);
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content.length) {
          content += delta.content;
          onDelta(delta.content);
        }
        this.accumulateToolCalls(delta.tool_calls, slots);
      }
    }

    const toolCalls: ToolCall[] = [...slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, s]) => ({
        id: s.id,
        type: 'function',
        function: { name: s.name, arguments: s.args },
      }));

    return {
      role: 'assistant',
      content: content.length ? content : null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
  }

  private parseDelta(line: string): ChatCompletionDelta | null {
    if (!line.startsWith('data:')) return null;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      const parsed = JSON.parse(payload) as ChatCompletionChunk;
      return parsed.choices?.[0]?.delta ?? null;
    } catch {
      return null;
    }
  }

  private accumulateToolCalls(
    toolCalls: ChatCompletionDeltaToolCall[] | undefined,
    slots: Map<number, ToolCallSlot>,
  ): void {
    for (const tc of toolCalls ?? []) {
      const slot = slots.get(tc.index) ?? { id: '', name: '', args: '' };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      slots.set(tc.index, slot);
    }
  }
}
