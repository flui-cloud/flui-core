import { Injectable } from '@nestjs/common';
import {
  AssistantInferenceService,
  InferenceSelection,
} from '../../assistant/services/assistant-inference.service';
import { AssistantLlmService } from '../../assistant/services/assistant-llm.service';
import { DbConnectionResolveInput } from '../interfaces/db-connection';
import { KeyspaceSummary } from '../engine/keyvalue-engine';
import {
  isKnownRedisCommand,
  isReadOnlyCommand,
} from '../engine/redis-commands';
import { EngineKnowledgeService } from '../knowledge/engine-knowledge.service';
import { KvQueryService } from './kv-query.service';
import { DbConsoleAuditService } from './db-console-audit.service';

export interface KvAssistTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface KvAssistResult {
  command: string;
  explanation: string;
  /** True when the command writes/destroys — the UI gates it behind a confirm. */
  mutation: boolean;
}

/**
 * Data-blind NL→Redis-command copilot. It receives the data-blind keyspace summary (key count
 * + type breakdown — never key names or values) + the curated Redis/Valkey KB, and returns a
 * single runnable command. Reuses the Flui Assistant's inference plumbing verbatim.
 */
@Injectable()
export class KvAssistService {
  constructor(
    private readonly inference: AssistantInferenceService,
    private readonly llm: AssistantLlmService,
    private readonly knowledge: EngineKnowledgeService,
    private readonly kv: KvQueryService,
    private readonly audit: DbConsoleAuditService,
  ) {}

  async assist(
    input: DbConnectionResolveInput,
    prompt: string,
    conversation: KvAssistTurn[] = [],
    selection: InferenceSelection = {},
  ): Promise<KvAssistResult> {
    const summary = await this.kv.summary(input);

    const { endpoint } = await this.inference.resolveEndpoint(selection);
    const model = await this.inference.resolveModel(selection, endpoint);

    const system = [
      // 'redis' KB also serves valkey (same protocol/commands).
      this.knowledge.getSystemContext('redis'),
      '# Live keyspace (data-blind: counts only)',
      this.serializeSummary(summary),
    ].join('\n\n');

    const response = await this.llm.chat(endpoint, {
      model,
      messages: [
        { role: 'system', content: system },
        ...conversation.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
      stream: false,
    });

    const result = this.parse(response.choices?.[0]?.message?.content ?? '');

    this.audit.emit({
      dbInstallId: input.dbInstallId,
      userId: input.fluiUserId,
      role: 'owner',
      command: result.mutation ? 'assist:mutation' : 'assist:read',
      rowCount: 0,
      readOnly: !result.mutation,
      durationMs: 0,
      failed: false,
    });

    return result;
  }

  private serializeSummary(s: KeyspaceSummary): string {
    const types = s.byType.length
      ? s.byType.map((t) => `${t.type}=${t.count}`).join(', ')
      : '(none sampled)';
    return [
      `- total keys: ${s.keyCount}`,
      `- sampled ${s.sampled} keys`,
      `- types (sampled): ${types}`,
    ].join('\n');
  }

  private parse(raw: string): KvAssistResult {
    let command = '';
    let explanation = '';

    const obj = this.tryJson(raw);
    if (obj && typeof obj.command === 'string') {
      command = obj.command.trim();
      explanation = (obj.explanation ?? '').trim();
    } else {
      // Non-strict JSON (trailing comma, etc.) — pull the fields by regex rather than letting
      // a fenced JSON blob slip through as the "command" (which would send a literal "{").
      command = this.extractField(raw, 'command');
      explanation = this.extractField(raw, 'explanation');
      if (!explanation)
        explanation = raw.replaceAll(/```[\s\S]*?```/g, '').trim();
    }
    if (command.startsWith('{')) command = '';

    // Fallback for models that ignore the contract and inline the command in prose: find a
    // line that begins with a known Redis command, lift it out, and trim it from the text.
    if (!command) {
      command = this.extractCommandFromText(raw);
      if (command && explanation.includes(command)) {
        explanation = explanation.replace(command, '').trim();
      }
    }
    return { command, explanation, mutation: this.isMutation(command) };
  }

  // Scan free-form text for a runnable Redis command line (first token is a known command).
  private extractCommandFromText(text: string): string {
    for (const rawLine of text.split('\n')) {
      let line = rawLine.trim().replace(/^[`>*\-\d.)\s]+/, ''); // strip leading list/quote/backtick markers
      while (line.endsWith('`')) line = line.slice(0, -1);
      line = line.trim();
      const first = /^([A-Za-z]+)/.exec(line)?.[1];
      if (first && isKnownRedisCommand(first)) return line;
    }
    return '';
  }

  // Tolerant extraction of a JSON string field from imperfect model output.
  private extractField(raw: string, key: string): string {
    const m = new RegExp(
      String.raw`"${key}"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"`,
    ).exec(raw);
    if (!m) return '';
    try {
      return JSON.parse(`"${m[1]}"`).trim();
    } catch {
      return m[1].trim();
    }
  }

  private tryJson(
    raw: string,
  ): { command?: string; explanation?: string } | null {
    const body = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/, '')
      .trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as {
        command?: string;
        explanation?: string;
      };
      if (
        typeof parsed.command === 'string' ||
        typeof parsed.explanation === 'string'
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  // UI hint only — the read-only gate is the real boundary. First token decides.
  private isMutation(command: string): boolean {
    const first = /^\s*([A-Za-z]+)/.exec(command)?.[1];
    if (!first) return false;
    return !isReadOnlyCommand(first);
  }
}
