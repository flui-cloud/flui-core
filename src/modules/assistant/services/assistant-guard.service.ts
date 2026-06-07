import { Injectable } from '@nestjs/common';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { ChatMessageDto } from '../dto/chat-message.dto';
import { AssistantLlmService } from './assistant-llm.service';

const ROUTER_SYSTEM = `You are the gate and router for the Flui Assistant.
Flui is a platform for running applications on a user's own cloud: clusters, nodes, environments, applications, the catalog, observability, DNS, TLS, firewalls, vnets, identity/OIDC, storage, the build pipeline, the flui CLI, and the flui.yaml manifest.
You are given an INDEX of knowledge sections, one per line as "id — title". Based on the LAST user message in the context of the conversation:
- If the request is clearly NOT about Flui (e.g. philosophy, the weather, general trivia, unrelated coding), reply with exactly: OFF_TOPIC
- Otherwise reply with the ids of the 1 to 4 most relevant sections, comma-separated, most relevant first. Use only ids from the INDEX. Output ids only — no prose, no titles.
Bias toward answering: if it plausibly concerns Flui, or is a greeting or a follow-up, pick sections instead of OFF_TOPIC.`;

const REFUSAL_SYSTEM = `You are the Flui Assistant. The user's message is OUTSIDE Flui's scope, so you must NOT answer it.
In the user's own language, in one or two short, warm sentences: say you are the Flui Assistant and can only help with Flui — its platform, the flui CLI, the flui.yaml manifest, the catalog, and install/troubleshooting — then invite a Flui-related question. Do not answer their actual question.`;

const FALLBACK_REFUSAL =
  "I'm the Flui Assistant — I can only help with Flui (the platform, its CLI, flui.yaml, the catalog, and install/troubleshooting). Ask me anything about those, for example how to create your first cluster.";

export interface RouteDecision {
  offTopic: boolean;
  sectionIds: string[];
}

@Injectable()
export class AssistantGuardService {
  constructor(private readonly llm: AssistantLlmService) {}

  // One cheap call (small prompt → fast on any model): gate off-topic AND pick the
  // knowledge sections to inject, so the answer prompt stays small. Unknown ids are
  // dropped downstream by KnowledgeService.
  async route(
    endpoint: InferenceEndpoint,
    model: string,
    messages: ChatMessageDto[],
    indexPrompt: string,
  ): Promise<RouteDecision> {
    const recent = messages.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const result = await this.llm.chat(endpoint, {
      model,
      messages: [
        {
          role: 'system',
          content: `${ROUTER_SYSTEM}\n\nINDEX:\n${indexPrompt}`,
        },
        ...recent,
      ],
      temperature: 0,
      max_tokens: 64,
      stream: false,
    });
    const out = result.choices?.[0]?.message?.content?.trim() ?? '';
    if (out.toUpperCase().includes('OFF_TOPIC')) {
      return { offTopic: true, sectionIds: [] };
    }
    const sectionIds = out
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return { offTopic: false, sectionIds };
  }

  async refusal(
    endpoint: InferenceEndpoint,
    model: string,
    messages: ChatMessageDto[],
  ): Promise<string> {
    const lastUser =
      [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    try {
      const result = await this.llm.chat(endpoint, {
        model,
        messages: [
          { role: 'system', content: REFUSAL_SYSTEM },
          { role: 'user', content: lastUser },
        ],
        temperature: 0.2,
        max_tokens: 120,
        stream: false,
      });
      return result.choices?.[0]?.message?.content?.trim() || FALLBACK_REFUSAL;
    } catch {
      return FALLBACK_REFUSAL;
    }
  }
}
