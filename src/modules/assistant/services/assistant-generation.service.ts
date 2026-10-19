import { Injectable, Logger } from '@nestjs/common';
import { ApplicationService } from '../../applications/services/application.service';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import {
  collectHosts,
  DOCUMENTATION_HOSTS,
  hostOf,
  findUnverifiedUrls,
  isPlaceholderHost,
  stripUrls,
} from './url-guard.util';
import {
  DEFAULT_ASSISTANT_TEMPERATURE,
  MAX_ASSISTANT_OUTPUT_TOKENS,
  outputTokenLimit,
} from '../assistant.constants';
import { AgentRequestDto } from '../dto/agent-request.dto';
import { AgentToolStep } from '../interfaces/agent';
import { AgentEmitter } from '../interfaces/agent-events';
import {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatTool,
} from '../interfaces/chat-completion';
import { AssistantLlmService } from './assistant-llm.service';

const REWRITE_MIN_TOKENS = 256;
const REWRITE_MAX_TOKENS = 2048;
// A rewrite much shorter than the draft has dropped the answer, not just a URL.
const REWRITE_MIN_KEPT_RATIO = 0.5;

export function rewriteTokenBudget(
  draft: string,
  cap: number | undefined,
): number {
  const estimate = Math.ceil(draft.length / 3) + 128;
  const bounded = Math.min(
    Math.max(estimate, REWRITE_MIN_TOKENS),
    REWRITE_MAX_TOKENS,
  );
  return Math.min(bounded, cap ?? MAX_ASSISTANT_OUTPUT_TOKENS);
}

/**
 * A provider not known to take several system messages gets them joined into
 * one, the exact text a single message carried before the prompt was split.
 */
export function fitSystemMessages(
  endpoint: InferenceEndpoint,
  messages: ChatCompletionMessage[],
): ChatCompletionMessage[] {
  if (endpoint.acceptsSeveralSystemMessages) return messages;
  let lead = 0;
  while (lead < messages.length && messages[lead].role === 'system') lead++;
  if (lead < 2) return messages;
  return [
    {
      role: 'system',
      content: messages
        .slice(0, lead)
        .map((m) => m.content ?? '')
        .join('\n\n'),
    },
    ...messages.slice(lead),
  ];
}

function hostsOf(urls: string[]): string[] {
  return [...new Set(urls.map((u) => hostOf(u) ?? u))];
}

/**
 * One model generation, plus the deterministic guard against a fabricated app URL —
 * the guard has to regenerate through the same call, so the two live together.
 */
@Injectable()
export class AssistantGenerationService {
  private readonly logger = new Logger(AssistantGenerationService.name);

  constructor(
    private readonly llm: AssistantLlmService,
    private readonly apps: ApplicationService,
    private readonly installer: CatalogInstallerService,
  ) {}

  /**
   * One model generation, returning the assembled assistant message. When `emit`
   * is present the call streams: text tokens flow out as `delta` events and the
   * tool-call fragments are reassembled; otherwise it's a single buffered call.
   */
  async generate(
    endpoint: InferenceEndpoint,
    model: string,
    messages: ChatCompletionMessage[],
    dto: AgentRequestDto,
    tools: ChatTool[] | undefined,
    emit: AgentEmitter | undefined,
    maxTokens?: number,
  ): Promise<ChatCompletionMessage | null> {
    const request: ChatCompletionRequest = {
      model,
      messages: fitSystemMessages(endpoint, messages),
      temperature: dto.temperature ?? DEFAULT_ASSISTANT_TEMPERATURE,
      max_tokens:
        maxTokens ?? outputTokenLimit(endpoint.spender, dto.maxTokens),
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    };
    if (emit) {
      return this.llm.chatStream(endpoint, request, (text) =>
        emit({ type: 'delta', text }),
      );
    }
    const response = await this.llm.chat(endpoint, {
      ...request,
      stream: false,
    });
    return response.choices?.[0]?.message ?? null;
  }

  /**
   * Last line of defence against a fabricated URL: regenerate once naming the
   * unverified URLs, keep the draft if the rewrite lost the answer, strip what
   * still slips through.
   */
  async finalizeContent(
    content: string,
    conversation: ChatCompletionMessage[],
    steps: AgentToolStep[],
    endpoint: InferenceEndpoint,
    model: string,
    dto: AgentRequestDto,
    leanSystem: ChatCompletionMessage[],
    grounding: ChatCompletionMessage[] = [],
  ): Promise<string> {
    if (!content) return content;
    const sources: string[] = [];
    for (const m of grounding) {
      if (typeof m.content === 'string') sources.push(m.content);
    }
    for (const m of conversation) {
      if (
        (m.role === 'tool' || m.role === 'user') &&
        typeof m.content === 'string'
      ) {
        sources.push(m.content);
      }
    }
    for (const s of steps) {
      if (s.result !== undefined) sources.push(JSON.stringify(s.result));
    }
    const sourceHosts = collectHosts(sources);
    const offenders = await this.unverifiedUrls(content, sourceHosts);
    if (!offenders.length) return content;

    // Must be a 'user' turn, not 'system': it follows the assistant draft, and
    // providers reject a system message after an assistant message.
    const constraint: ChatCompletionMessage = {
      role: 'user',
      content: [
        'These URLs in your previous answer do not come from a tool result, the documentation or the user, so they may not exist:',
        ...offenders.map((u) => `- ${u}`),
        'Rewrite the same answer in the same language with everything else unchanged, without those URLs. A documentation link can simply be dropped: the relevant documentation links are added to your answer automatically. Where an example needs an application address, write <your-app-url>. Do not apologise and do not mention this instruction.',
      ].join('\n'),
    };
    const regenerated = await this.generate(
      endpoint,
      model,
      [...leanSystem, ...conversation, constraint],
      dto,
      undefined,
      undefined,
      rewriteTokenBudget(
        content,
        outputTokenLimit(endpoint.spender, dto.maxTokens),
      ),
    ).catch(() => null);

    const rewrite = regenerated?.content?.trim() ?? '';
    const keepRewrite =
      rewrite.length >= content.length * REWRITE_MIN_KEPT_RATIO;
    let safe = keepRewrite ? rewrite : content;
    const residual = await this.unverifiedUrls(safe, sourceHosts);
    safe = stripUrls(safe, residual);
    this.logger.warn(
      `URL guard: unverified ${hostsOf(offenders).join(', ')}; rewrite ${keepRewrite ? 'kept' : 'discarded'}, ${residual.length} stripped`,
    );

    const lastAssistant = [...conversation]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (lastAssistant) lastAssistant.content = safe;
    return safe;
  }

  /**
   * URLs in `text` that are neither sourced (a host seen in a tool result / user
   * message), nor a known-safe external host, nor — verified against the source of
   * truth — a real app endpoint fqdn or catalog resolvedFqdn in the DB. Mode-agnostic:
   * it never reasons about the URL's shape, only whether the host actually exists.
   */
  private async unverifiedUrls(
    text: string,
    sourceHosts: Set<string>,
  ): Promise<string[]> {
    const allowed = new Set<string>(sourceHosts);
    for (const host of DOCUMENTATION_HOSTS) allowed.add(host);
    const toVerify = [...collectHosts([text])].filter(
      (h) => !allowed.has(h) && !isPlaceholderHost(h),
    );
    if (toVerify.length) {
      const [endpoints, resolved] = await Promise.all([
        this.apps.filterKnownEndpointHosts(toVerify),
        this.installer.existingResolvedFqdns(toVerify),
      ]);
      for (const host of [...endpoints, ...resolved]) {
        allowed.add(host.toLowerCase());
      }
    }
    return findUnverifiedUrls(text, allowed);
  }
}
