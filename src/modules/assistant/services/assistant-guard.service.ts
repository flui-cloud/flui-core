import { Injectable } from '@nestjs/common';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { AssistantLlmService } from './assistant-llm.service';

/** Minimal message shape the gate/router reads (role + text). */
export interface RouteMessage {
  role: string;
  content: string;
}

const ROUTER_SYSTEM = `You are the gate and router for the Flui Assistant.
Flui is a platform for running applications on a user's own cloud: clusters, nodes, environments, applications, the catalog, observability/logs, DNS, TLS, firewalls, vnets, identity/OIDC, storage, the build pipeline, the flui CLI, and the flui.yaml manifest.
The user is an operator talking to the assistant INSIDE Flui. Treat as ON-TOPIC any question about THEIR OWN resources or operations — "how many apps/applications", "what's deployed", "releases", "deploy/redeploy", "clusters", "nodes", "logs", "status", "catalog", "install" — even when the word "Flui" is not mentioned. These are the core use cases.
You are given an INDEX of knowledge sections, one per line as "id — title". Based on the LAST user message in the context of the conversation:
- Reply OFF_TOPIC ONLY if the request is unmistakably unrelated to Flui or cloud operations (e.g. the weather, philosophy, politics, general trivia, math homework). When in doubt, it is ON-TOPIC.
- Otherwise reply with the ids of the 1 to 4 most relevant sections, comma-separated, most relevant first. Use only ids from the INDEX. Output ids only — no prose, no titles.
Strong bias toward answering: greetings, follow-ups, and anything that plausibly concerns running apps on Flui get section ids, never OFF_TOPIC.`;

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
    messages: RouteMessage[],
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
    messages: RouteMessage[],
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
