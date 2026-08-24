import { Injectable } from '@nestjs/common';
import {
  AssistantInferenceService,
  InferenceSelection,
} from '../../assistant/services/assistant-inference.service';
import { AssistantLlmService } from '../../assistant/services/assistant-llm.service';
import { SearchResolveInput } from '../interfaces/search-connection';
import { SearchQueryService } from './search-query.service';
import { DbConsoleAuditService } from './db-console-audit.service';
import { RawRestMethod, classifyEsRequest } from '../engine/raw-rest';
/* eslint-disable @typescript-eslint/no-require-imports */
import opensearchKb = require('../knowledge/dist/opensearch.kb.json');
import opensearchDevtoolsKb = require('../knowledge/dist/opensearch-devtools.kb.json');
/* eslint-enable @typescript-eslint/no-require-imports */

export interface SearchAssistTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SearchAssistResult {
  /** Target index for the generated request. */
  index: string;
  /** Query-DSL request body (the object sent to GET <index>/_search). */
  body: Record<string, unknown>;
  explanation: string;
}

export interface SearchAssistScope {
  /** Active index the user is looking at, if any — used to ground field references. */
  index?: string;
}

export interface SearchRawAssistResult {
  method: RawRestMethod;
  path: string;
  body?: Record<string, unknown>;
  explanation: string;
  /** True when the generated call mutates data/settings (per the engine classifier). */
  write: boolean;
}

interface KbSection {
  id: string;
  title: string;
  body: string;
}
interface Kb {
  kbVersion: string;
  dialect: string;
  guardrails: string;
  sections: KbSection[];
}

const KB = opensearchKb as unknown as Kb;
const DEVTOOLS_KB = opensearchDevtoolsKb as unknown as Kb;

/**
 * Data-blind NL→query-DSL copilot for the search console. It receives the curated OpenSearch
 * KB + a data-blind structure summary (index NAMES, and the active index's field paths + types
 * from the mapping — never document values) and returns a single runnable `{ index, body }`
 * search request. Reuses the Flui Assistant's inference plumbing verbatim, exactly like the
 * SQL, key-value and document copilots. Read-only by contract — the console only runs _search.
 */
@Injectable()
export class SearchAssistService {
  constructor(
    private readonly inference: AssistantInferenceService,
    private readonly llm: AssistantLlmService,
    private readonly search: SearchQueryService,
    private readonly audit: DbConsoleAuditService,
  ) {}

  async assist(
    input: SearchResolveInput,
    prompt: string,
    conversation: SearchAssistTurn[] = [],
    selection: InferenceSelection = {},
    scope: SearchAssistScope = {},
  ): Promise<SearchAssistResult> {
    const { endpoint } = await this.inference.resolveEndpoint(selection, {
      userId: input.fluiUserId,
    });
    const model = await this.inference.resolveModel(selection, endpoint);

    const system = [
      this.systemContext(),
      '# Live structure (data-blind: index + field names/types only, never values)',
      await this.serializeStructure(input, scope),
    ].join('\n\n');

    const response = await this.llm.chat(endpoint, {
      model,
      messages: [
        { role: 'system', content: system },
        ...conversation.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 800,
      stream: false,
    });

    const result = this.parse(response.choices?.[0]?.message?.content ?? '');

    this.audit.emit({
      dbInstallId: input.appId,
      userId: input.fluiUserId,
      role: 'owner',
      command: 'assist:read',
      rowCount: 0,
      readOnly: true,
      durationMs: 0,
      failed: false,
    });

    return result;
  }

  /**
   * Dev Tools copilot: NL → one raw REST request { method, path, body? }. Same inference
   * plumbing + data-blind structure as the search copilot, but a REST-surface KB and an
   * output the Dev Tools console runs (writes gated by the console's read-only toggle). The
   * mutating/read nature is derived from the engine classifier, not trusted from the model.
   */
  async assistRaw(
    input: SearchResolveInput,
    prompt: string,
    conversation: SearchAssistTurn[] = [],
    selection: InferenceSelection = {},
    scope: SearchAssistScope = {},
  ): Promise<SearchRawAssistResult> {
    const { endpoint } = await this.inference.resolveEndpoint(selection, {
      userId: input.fluiUserId,
    });
    const model = await this.inference.resolveModel(selection, endpoint);

    const system = [
      this.systemContextFrom(
        DEVTOOLS_KB,
        '- Produce exactly one raw REST call (method + path + optional JSON body).',
      ),
      '# Live structure (data-blind: index + field names/types only, never values)',
      await this.serializeStructure(input, scope),
    ].join('\n\n');

    const response = await this.llm.chat(endpoint, {
      model,
      messages: [
        { role: 'system', content: system },
        ...conversation.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 800,
      stream: false,
    });

    const result = this.parseRaw(response.choices?.[0]?.message?.content ?? '');

    this.audit.emit({
      dbInstallId: input.appId,
      userId: input.fluiUserId,
      role: 'owner',
      command: result.write ? 'assist-raw:write' : 'assist-raw:read',
      rowCount: 0,
      readOnly: !result.write,
      durationMs: 0,
      failed: false,
    });

    return result;
  }

  private systemContext(): string {
    return this.systemContextFrom(
      KB,
      '- Only standard query-DSL is valid; prefer widely-supported clauses.',
    );
  }

  private systemContextFrom(kb: Kb, engineNote: string): string {
    const corpus = kb.sections
      .map((s) => `## ${s.title}\n_(${s.id})_\n\n${s.body}`)
      .join('\n\n');
    return [
      kb.guardrails,
      '# Target engine',
      '- Engine: OpenSearch (Elasticsearch wire / REST)',
      engineNote,
      '# OpenSearch knowledge',
      corpus,
    ].join('\n\n');
  }

  // Index names + the active index's field paths and types only — never document contents.
  // Best-effort: any introspection failure just yields a thinner context, never a broken assist.
  private async serializeStructure(
    input: SearchResolveInput,
    scope: SearchAssistScope,
  ): Promise<string> {
    const lines: string[] = [];
    try {
      const indices = await this.search.listIndices(input);
      const names = indices
        .map((i) => i.name)
        .filter((n) => !n.startsWith('.'));
      lines.push(
        names.length ? `- indices: ${names.join(', ')}` : '- indices: (none)',
      );
    } catch {
      lines.push('- indices: (unavailable)');
    }
    if (scope.index) {
      lines.push(`- active index: ${scope.index}`);
      try {
        const mapping = await this.search.getMapping(input, scope.index);
        const fields = this.flattenMapping(mapping, scope.index);
        if (fields.length) {
          lines.push('- fields (path: type):');
          for (const f of fields.slice(0, 200)) lines.push(`    ${f}`);
        }
      } catch {
        lines.push('- fields: (unavailable)');
      }
    } else {
      lines.push('(no active index — ask the user which index to target)');
    }
    return lines.join('\n');
  }

  /**
   * Flatten an OpenSearch mapping into `path: type` lines. Handles the
   * `{ <index>: { mappings: { properties } } }` shape, nested `properties`,
   * and `text` fields with a `.keyword` sub-field (surfaced as a hint).
   */
  private flattenMapping(
    mapping: Record<string, unknown>,
    index: string,
  ): string[] {
    const root =
      (mapping?.[index] as { mappings?: { properties?: unknown } })?.mappings
        ?.properties ??
      (mapping?.mappings as { properties?: unknown })?.properties ??
      mapping?.properties;
    const out: string[] = [];
    const walk = (props: Record<string, unknown>, prefix: string): void => {
      for (const [name, raw] of Object.entries(props ?? {})) {
        const def = raw as {
          type?: string;
          properties?: Record<string, unknown>;
          fields?: Record<string, { type?: string }>;
        };
        const path = prefix ? `${prefix}.${name}` : name;
        if (def.properties) {
          walk(def.properties, path);
          continue;
        }
        const sub = def.fields?.keyword ? ` (+${path}.keyword)` : '';
        out.push(`${path}: ${def.type ?? 'object'}${sub}`);
      }
    };
    if (root && typeof root === 'object') {
      walk(root as Record<string, unknown>, '');
    }
    return out;
  }

  private parseRaw(raw: string): SearchRawAssistResult {
    const obj = this.tryJson(raw) as unknown as Record<string, unknown> | null;
    const allowed = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'];
    const methodRaw =
      obj && typeof obj.method === 'string' ? obj.method.toUpperCase() : '';
    const path = obj && typeof obj.path === 'string' ? obj.path.trim() : '';
    const body =
      obj?.body && typeof obj.body === 'object'
        ? (obj.body as Record<string, unknown>)
        : undefined;
    const explanation =
      obj && typeof obj.explanation === 'string' ? obj.explanation.trim() : '';
    if (!allowed.includes(methodRaw) || !path) {
      return {
        method: 'GET',
        path: '',
        explanation:
          explanation || raw.trim() || 'Could not produce a request.',
        write: false,
      };
    }
    const method = methodRaw as RawRestMethod;
    const write = classifyEsRequest({ method, path, body }) === 'write';
    return { method, path, body, explanation, write };
  }

  private parse(raw: string): SearchAssistResult {
    const obj = this.tryJson(raw);
    if (obj) {
      const body =
        obj.body && typeof obj.body === 'object'
          ? (obj.body as Record<string, unknown>)
          : {};
      return {
        index: typeof obj.index === 'string' ? obj.index.trim() : '',
        body,
        explanation:
          typeof obj.explanation === 'string' ? obj.explanation.trim() : '',
      };
    }
    // No parseable JSON — return an empty request with the raw text as explanation
    // so the UI shows the model's message rather than a broken body.
    return { index: '', body: {}, explanation: raw.trim() };
  }

  private tryJson(
    raw: string,
  ): { index?: unknown; body?: unknown; explanation?: unknown } | null {
    const body = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/, '')
      .trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
