import { Injectable } from '@nestjs/common';
import { ApplicationService } from '../../applications/services/application.service';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { collectHosts, findUnverifiedUrls } from './url-guard.util';
import { DEFAULT_ASSISTANT_TEMPERATURE } from '../assistant.constants';
import { AgentRequestDto } from '../dto/agent-request.dto';
import { AgentToolStep } from '../interfaces/agent';
import { AgentEmitter } from '../interfaces/agent-events';
import {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatTool,
} from '../interfaces/chat-completion';
import { AssistantLlmService } from './assistant-llm.service';

// Hosts the agent may legitimately cite that are not Flui endpoints — kept tiny and
// extensible; anything else must be a tool/user source or a DB-verified endpoint.
const STATIC_EXTERNAL_HOSTS = new Set(['github.com', 'gitlab.com']);

/**
 * One model generation, plus the deterministic guard against a fabricated app URL —
 * the guard has to regenerate through the same call, so the two live together.
 */
@Injectable()
export class AssistantGenerationService {
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
  ): Promise<ChatCompletionMessage | null> {
    const request: ChatCompletionRequest = {
      model,
      messages,
      temperature: dto.temperature ?? DEFAULT_ASSISTANT_TEMPERATURE,
      max_tokens: dto.maxTokens,
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
   * Deterministic last line of defence against a fabricated app URL: if the answer
   * names an app-endpoint host that never appeared in a tool result (the model
   * imitating a real URL it saw earlier), regenerate ONCE with the fact injected,
   * and as a final safety net strip any URL that still slips through. Keeps the
   * conversation history in sync so the bad draft cannot be parroted next turn.
   */
  async finalizeContent(
    content: string,
    conversation: ChatCompletionMessage[],
    steps: AgentToolStep[],
    endpoint: InferenceEndpoint,
    model: string,
    dto: AgentRequestDto,
    leanSystem: ChatCompletionMessage,
  ): Promise<string> {
    if (!content) return content;
    const sources: string[] = [];
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
    if (!(await this.unverifiedUrls(content, sourceHosts)).length) {
      return content;
    }

    // Must be a 'user' turn, not 'system': it follows the assistant draft, and
    // providers reject a system message after an assistant message.
    const constraint: ChatCompletionMessage = {
      role: 'user',
      content:
        'Your previous answer named an app endpoint URL that is not a real endpoint — you invented it. Never state an app URL you did not get from an app_get/app_list tool result. If the app has no endpoint configured (e.g. a failed or incomplete install), say so plainly instead of giving a URL. Rewrite your previous answer now, removing every unverified URL.',
    };
    const regenerated = await this.generate(
      endpoint,
      model,
      [leanSystem, ...conversation, constraint],
      dto,
      undefined,
      undefined,
    );

    // Take the rewrite if it is clean; otherwise strip any URL that still slips
    // through so a fabricated link can never reach the user.
    let safe = regenerated?.content || content;
    for (const url of await this.unverifiedUrls(safe, sourceHosts)) {
      safe = safe.split(url).join('[endpoint non disponibile]');
    }

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
    for (const host of STATIC_EXTERNAL_HOSTS) allowed.add(host);
    const toVerify = [...collectHosts([text])].filter((h) => !allowed.has(h));
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
