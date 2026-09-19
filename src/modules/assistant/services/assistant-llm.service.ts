import { Injectable, Logger } from '@nestjs/common';
import { guardedRequest } from '../../../common/net/egress-guard';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { describeError } from '../../shared/utils/error.util';
import { toInferenceError } from './inference-error.util';
import { InferenceUsageService } from '../../inference/services/inference-usage.service';
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
  ChatCompletionUsage,
} from '../interfaces/chat-completion';

// Enough to reconcile a model that rejects several tuning params one at a time
// (e.g. temperature, then max_tokens); a safety net against a pathological loop.
const MAX_PARAM_RETRIES = 3;

type ToolCallSlot = { id: string; name: string; args: string };

@Injectable()
export class AssistantLlmService {
  private readonly logger = new Logger(AssistantLlmService.name);

  constructor(
    private readonly paramPolicy: ModelParamPolicyService,
    private readonly usage: InferenceUsageService,
  ) {}

  /**
   * Writes the bill for one call.
   *
   * Everything the platform spends on inference converges here, which is why
   * the ledger can honestly claim to be the whole of it — the assistant and the
   * six console copilots all arrive through this class.
   *
   * An endpoint with no spender is the platform calling on its own behalf and
   * is not billed to anyone. When the provider reported no counts, the text is
   * measured instead and the row says so: a budget built partly on guesses
   * should be able to admit which part.
   */
  private async meter(
    endpoint: InferenceEndpoint,
    request: ChatCompletionRequest,
    usage: ChatCompletionUsage | undefined,
    answer?: string | null,
  ): Promise<void> {
    if (!endpoint.spender) return;
    const estimated = !usage;
    const promptTokens =
      usage?.prompt_tokens ?? roughTokens(JSON.stringify(request.messages));
    const completionTokens =
      usage?.completion_tokens ?? roughTokens(answer ?? '');
    await this.usage.record({
      userId: endpoint.spender.userId,
      guest: endpoint.spender.guest,
      surface: endpoint.spender.surface,
      model: request.model,
      endpoint: endpoint.baseUrl,
      promptTokens,
      completionTokens,
      estimated,
    });
  }

  async chat(
    endpoint: InferenceEndpoint,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const url = `${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const answer = await this.send(endpoint, request, async (req) => {
      const response = await guardedRequest<ChatCompletionResponse>({
        method: 'POST',
        url,
        data: req,
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
        timeout: 60000,
      });
      return response.data;
    });
    await this.meter(
      endpoint,
      request,
      answer.usage,
      answer.choices?.[0]?.message?.content,
    );
    return answer;
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
    const result = await this.send(endpoint, request, async (req) => {
      const response = await guardedRequest<NodeJS.ReadableStream>({
        method: 'POST',
        url,
        // Asked for explicitly: without it most providers stream the answer and
        // never say what it cost, and a meter that reads zero is worse than no
        // meter at all.
        data: { ...req, stream: true, stream_options: { include_usage: true } },
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
        timeout: 60000,
        responseType: 'stream',
      });
      return this.consumeStream(response.data, onDelta);
    });
    await this.meter(endpoint, request, result.usage, result.message.content);
    return result.message;
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
  ): Promise<{ message: ChatCompletionMessage; usage?: ChatCompletionUsage }> {
    let buffer = '';
    let content = '';
    let usage: ChatCompletionUsage | undefined;
    const slots = new Map<number, ToolCallSlot>();

    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const parsed = this.parseChunk(line);
        if (!parsed) continue;
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta;
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
      message: {
        role: 'assistant',
        content: content.length ? content : null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
      usage,
    };
  }

  /**
   * The whole chunk rather than only its delta: an OpenAI-compatible stream
   * reports what the call cost in a final chunk that carries `usage` and no
   * choices at all, so a parser that reached straight for `choices[0].delta`
   * threw the bill away.
   */
  private parseChunk(line: string): ChatCompletionChunk | null {
    if (!line.startsWith('data:')) return null;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      return JSON.parse(payload) as ChatCompletionChunk;
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

/**
 * A count for when the provider gave none. Four characters to a token is the
 * usual rule of thumb for these models — wrong in the third digit, right in the
 * first, and a budget needs the first.
 */
function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
