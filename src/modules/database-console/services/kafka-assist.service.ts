import { Injectable, Logger } from '@nestjs/common';
import {
  AssistantInferenceService,
  InferenceSelection,
} from '../../assistant/services/assistant-inference.service';
import { AssistantLlmService } from '../../assistant/services/assistant-llm.service';
import { COMMAND_CATALOG, parseCommand } from '../../../kafka-client';
import { KafkaResolveInput } from '../interfaces/kafka-connection';
import { KafkaQueryService } from './kafka-query.service';
import { DbConsoleAuditService } from './db-console-audit.service';

export interface KafkaAssistTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface KafkaAssistResult {
  /** The generated kafka-shell command. */
  command: string;
  explanation: string;
  /** True when the command writes (topic create/delete, produce) — UI gates it. */
  mutation: boolean;
}

/**
 * NL -> kafka-shell copilot. Grounds the model in the exact command grammar plus
 * the live topic/group names (metadata only — never message payloads) and asks
 * for one command. Reuses the Flui Assistant's inference plumbing, like the SQL
 * copilot. Mutation is decided by parsing the generated command, not by heuristic.
 */
@Injectable()
export class KafkaAssistService {
  private readonly logger = new Logger(KafkaAssistService.name);

  constructor(
    private readonly inference: AssistantInferenceService,
    private readonly llm: AssistantLlmService,
    private readonly queryService: KafkaQueryService,
    private readonly audit: DbConsoleAuditService,
  ) {}

  async assist(
    input: KafkaResolveInput,
    prompt: string,
    conversation: KafkaAssistTurn[] = [],
    selection: InferenceSelection = {},
  ): Promise<KafkaAssistResult> {
    const context = await this.liveContext(input);

    const { endpoint } = await this.inference.resolveEndpoint(selection, {
      userId: input.fluiUserId,
    });
    const model = await this.inference.resolveModel(selection, endpoint);

    const response = await this.llm.chat(endpoint, {
      model,
      messages: [
        { role: 'system', content: this.system(context) },
        ...conversation.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 600,
      stream: false,
    });

    const raw = response.choices?.[0]?.message?.content ?? '';
    const result = this.parse(raw);

    this.audit.emit({
      dbInstallId: input.appId,
      userId: input.fluiUserId,
      role: 'owner',
      command: result.mutation ? 'kafka.assist:mutation' : 'kafka.assist:read',
      rowCount: 0,
      readOnly: !result.mutation,
      durationMs: 0,
      failed: false,
    });

    return result;
  }

  private async liveContext(
    input: KafkaResolveInput,
  ): Promise<{ topics: string[]; groups: string[] }> {
    try {
      const [topics, groups] = await Promise.all([
        this.queryService.topics(input),
        this.queryService.groups(input),
      ]);
      return {
        topics: topics.map((t) => t.name).slice(0, 200),
        groups: groups.map((g) => g.groupId).slice(0, 200),
      };
    } catch (err) {
      // Best-effort: a copilot without live context still produces valid grammar.
      this.logger.warn(
        `kafka assist live context unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { topics: [], groups: [] };
    }
  }

  private system(context: { topics: string[]; groups: string[] }): string {
    const grammar = COMMAND_CATALOG.map(
      (c) => `- ${c.usage}${c.mutation ? '  (write)' : ''} — ${c.summary}`,
    ).join('\n');
    return [
      'You are a Kafka operations copilot. Translate the user request into exactly ONE kafka-shell command.',
      'Respond ONLY with JSON: {"command": "<one kafka-shell command>", "explanation": "<short why>"}.',
      'Use only this grammar — never invent flags or verbs:',
      grammar,
      'Rules: emit a single command; quote values containing spaces with double quotes; prefer read commands unless the user clearly asks to write; only reference existing topics/groups unless the user is creating one.',
      '# Live cluster (metadata only)',
      `topics: ${context.topics.length ? context.topics.join(', ') : '(none)'}`,
      `consumer groups: ${context.groups.length ? context.groups.join(', ') : '(none)'}`,
    ].join('\n\n');
  }

  private parse(raw: string): KafkaAssistResult {
    const obj = this.tryJson(raw);
    const command = (obj?.command ?? '').trim();
    const explanation = (obj?.explanation ?? this.stripFences(raw)).trim();
    return { command, explanation, mutation: this.isMutation(command) };
  }

  private isMutation(command: string): boolean {
    if (!command) return false;
    try {
      return parseCommand(command).mutation;
    } catch {
      return false;
    }
  }

  private stripFences(raw: string): string {
    return raw.replaceAll(/```[\s\S]*?```/g, '').trim();
  }

  // Extract { command, explanation }: try each fenced block first (isolated from
  // prose), then the whole text — mirrors the SQL copilot's resilient parser.
  private tryJson(
    raw: string,
  ): { command?: string; explanation?: string } | null {
    const candidates: string[] = [];
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (let m = fence.exec(raw); m; m = fence.exec(raw)) candidates.push(m[1]);
    candidates.push(raw);
    for (const candidate of candidates) {
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start === -1 || end <= start) continue;
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
          command?: string;
          explanation?: string;
        };
        if (
          typeof parsed.command === 'string' ||
          typeof parsed.explanation === 'string'
        ) {
          return parsed;
        }
      } catch {
        // try the next candidate
      }
    }
    return null;
  }
}
