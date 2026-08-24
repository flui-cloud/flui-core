import { Injectable, Logger } from '@nestjs/common';
import {
  AssistantInferenceService,
  InferenceSelection,
} from '../../assistant/services/assistant-inference.service';
import { AssistantLlmService } from '../../assistant/services/assistant-llm.service';
import { classifyMeiliRequest } from '../engine/fulltext-engine';
import { RawRestMethod } from '../engine/raw-rest';
import { FulltextResolveInput } from '../interfaces/fulltext-connection';
import { FulltextQueryService } from './fulltext-query.service';
import { DbConsoleAuditService } from './db-console-audit.service';

export interface FulltextAssistTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface FulltextSearchSuggestion {
  index?: string;
  q: string;
  filter?: string;
  explanation: string;
}

export interface FulltextRawSuggestion {
  method: RawRestMethod;
  path: string;
  body?: Record<string, unknown>;
  explanation: string;
  /** True when the suggested call mutates data/settings — UI gates it. */
  write: boolean;
}

/**
 * NL copilot for the Meilisearch console. `assistSearch` proposes a search
 * (q + filter) for the browse panel; `assistRaw` proposes a raw REST call for the
 * Dev Tools shell. Grounded with the live index list (names only — never document
 * contents). Reuses the Flui Assistant inference plumbing, like the SQL copilot.
 */
@Injectable()
export class FulltextAssistService {
  private readonly logger = new Logger(FulltextAssistService.name);

  constructor(
    private readonly inference: AssistantInferenceService,
    private readonly llm: AssistantLlmService,
    private readonly queryService: FulltextQueryService,
    private readonly audit: DbConsoleAuditService,
  ) {}

  async assistSearch(
    input: FulltextResolveInput,
    prompt: string,
    index: string | undefined,
    conversation: FulltextAssistTurn[] = [],
    selection: InferenceSelection = {},
  ): Promise<FulltextSearchSuggestion> {
    const indexes = await this.indexNames(input);
    const { endpoint } = await this.inference.resolveEndpoint(selection, {
      userId: input.fluiUserId,
    });
    const model = await this.inference.resolveModel(selection, endpoint);
    const system = [
      'You are a Meilisearch copilot. Translate the user request into a single search.',
      'Respond ONLY with JSON: {"index":"<uid>","q":"<text>","filter":"<expr or empty>","explanation":"<short why>"}.',
      'q is the free-text query (empty string matches everything). filter uses Meilisearch syntax: =, !=, >, <, >=, <=, IN, TO, AND, OR, NOT, e.g. `genre = horror AND rating > 4`. Only set filter when the user asks to narrow by a field.',
      `Available indexes: ${indexes.length ? indexes.join(', ') : '(none)'}.`,
      index ? `Active index: ${index}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const raw = await this.chat(
      endpoint,
      model,
      system,
      conversation,
      prompt,
      500,
    );
    const obj = this.tryJson(raw, ['index', 'q', 'filter', 'explanation']);
    const result: FulltextSearchSuggestion = {
      index: (obj?.index as string) || index,
      q: ((obj?.q as string) ?? '').trim(),
      filter: ((obj?.filter as string) || '').trim() || undefined,
      explanation: (
        (obj?.explanation as string) ?? this.stripFences(raw)
      ).trim(),
    };
    this.emit(input, 'fulltext.assist:search', true);
    return result;
  }

  async assistRaw(
    input: FulltextResolveInput,
    prompt: string,
    conversation: FulltextAssistTurn[] = [],
    selection: InferenceSelection = {},
  ): Promise<FulltextRawSuggestion> {
    const indexes = await this.indexNames(input);
    const { endpoint } = await this.inference.resolveEndpoint(selection, {
      userId: input.fluiUserId,
    });
    const model = await this.inference.resolveModel(selection, endpoint);
    const system = [
      'You are a Meilisearch copilot for a raw REST "Dev Tools" console. Translate the request into ONE REST call.',
      'Respond ONLY with JSON: {"method":"GET|POST|PUT|PATCH|DELETE","path":"/...","body":{...or omit},"explanation":"<short why>"}.',
      'Meilisearch REST: GET /indexes, POST /indexes {"uid","primaryKey"}, DELETE /indexes/{uid}, GET|POST|PUT|DELETE /indexes/{uid}/documents, POST /indexes/{uid}/search {"q","filter","limit"}, GET|PATCH /indexes/{uid}/settings, GET /stats, GET /tasks, GET /health.',
      `Available indexes: ${indexes.length ? indexes.join(', ') : '(none)'}.`,
    ].join('\n\n');

    const raw = await this.chat(
      endpoint,
      model,
      system,
      conversation,
      prompt,
      600,
    );
    const obj = this.tryJson(raw, ['method', 'path', 'explanation']);
    const method = (
      typeof obj?.method === 'string' ? obj.method : 'GET'
    ).toUpperCase() as RawRestMethod;
    const path = ((obj?.path as string) ?? '').trim();
    const body =
      obj && typeof obj.body === 'object' && obj.body
        ? (obj.body as Record<string, unknown>)
        : undefined;
    const result: FulltextRawSuggestion = {
      method,
      path,
      body,
      explanation: (
        (obj?.explanation as string) ?? this.stripFences(raw)
      ).trim(),
      write: path
        ? classifyMeiliRequest({ method, path, body }) === 'write'
        : false,
    };
    this.emit(
      input,
      result.write ? 'fulltext.assist:write' : 'fulltext.assist:read',
      !result.write,
    );
    return result;
  }

  private async indexNames(input: FulltextResolveInput): Promise<string[]> {
    try {
      const idx = await this.queryService.listIndexes(input);
      return idx.map((i) => i.uid).slice(0, 200);
    } catch (err) {
      this.logger.warn(
        `fulltext assist context unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  private async chat(
    endpoint: Parameters<AssistantLlmService['chat']>[0],
    model: string,
    system: string,
    conversation: FulltextAssistTurn[],
    prompt: string,
    maxTokens: number,
  ): Promise<string> {
    const response = await this.llm.chat(endpoint, {
      model,
      messages: [
        { role: 'system', content: system },
        ...conversation.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      stream: false,
    });
    return response.choices?.[0]?.message?.content ?? '';
  }

  private emit(
    input: FulltextResolveInput,
    command: string,
    readOnly: boolean,
  ): void {
    this.audit.emit({
      dbInstallId: input.appId,
      userId: input.fluiUserId,
      role: 'owner',
      command,
      rowCount: 0,
      readOnly,
      durationMs: 0,
      failed: false,
    });
  }

  private stripFences(raw: string): string {
    return raw.replaceAll(/```[\s\S]*?```/g, '').trim();
  }

  private tryJson(raw: string, keys: string[]): Record<string, unknown> | null {
    const candidates: string[] = [];
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (let m = fence.exec(raw); m; m = fence.exec(raw)) candidates.push(m[1]);
    candidates.push(raw);
    for (const candidate of candidates) {
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start === -1 || end <= start) continue;
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<
          string,
          unknown
        >;
        if (keys.some((k) => k in parsed)) return parsed;
      } catch {
        // try the next candidate
      }
    }
    return null;
  }
}
