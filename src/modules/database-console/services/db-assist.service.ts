import { Injectable, Logger } from '@nestjs/common';
import {
  AssistantInferenceService,
  InferenceSelection,
} from '../../assistant/services/assistant-inference.service';
import { AssistantLlmService } from '../../assistant/services/assistant-llm.service';
import { DbConnectionResolveInput } from '../interfaces/db-connection';
import { SchemaTree } from '../engine/sql-engine';
import { EngineKnowledgeService } from '../knowledge/engine-knowledge.service';
import { DbQueryService } from './db-query.service';
import { DbConsoleAuditService } from './db-console-audit.service';

export interface AssistTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DbAssistResult {
  sql: string;
  explanation: string;
  /** True when the suggested SQL changes data/structure — UI gates it behind a confirm. */
  mutation: boolean;
}

// Keep the serialized schema bounded; very wide databases would otherwise blow the prompt.
// Table-level retrieval for huge schemas is a later enhancement (see module notes).
const MAX_SCHEMA_CHARS = 12_000;
const READ_LEADING = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'SHOW',
  'VALUES',
  'TABLE',
]);
const WRITE_IN_CTE = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i;

/**
 * The data-blind NL→SQL copilot. It assembles [data-blind guardrails + version binding +
 * curated Postgres KB + the live schema] and asks the configured inference endpoint for a
 * query. It introspects the schema (names + types only) but NEVER reads or forwards row data —
 * that is the core privacy contract. Reuses the Flui Assistant's inference plumbing verbatim.
 */
@Injectable()
export class DbAssistService {
  private readonly logger = new Logger(DbAssistService.name);

  constructor(
    private readonly inference: AssistantInferenceService,
    private readonly llm: AssistantLlmService,
    private readonly knowledge: EngineKnowledgeService,
    private readonly queryService: DbQueryService,
    private readonly audit: DbConsoleAuditService,
  ) {}

  async assist(
    input: DbConnectionResolveInput,
    prompt: string,
    conversation: AssistTurn[] = [],
    selection: InferenceSelection = {},
  ): Promise<DbAssistResult> {
    const schema = await this.queryService.introspect(input);

    // resolveEndpoint throws NotFoundException('No inference endpoint configured') when no
    // provider/connection exists — the controller lets it surface so the UI redirects to setup.
    // An empty selection resolves the same default the assistant uses.
    const { endpoint } = await this.inference.resolveEndpoint(selection, {
      userId: input.fluiUserId,
    });
    const model = await this.inference.resolveModel(selection, endpoint);

    const system = [
      this.knowledge.getSystemContext(schema.engine, schema.serverVersion),
      '# Live schema',
      this.serializeSchema(schema),
    ].join('\n\n');

    const response = await this.llm.chat(endpoint, {
      model,
      messages: [
        { role: 'system', content: system },
        ...conversation.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 900,
      stream: false,
    });

    const raw = response.choices?.[0]?.message?.content ?? '';
    const result = this.parse(raw);

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

  // Compact, token-cheap rendering: one line per table, `name type` per column.
  // Markers: `?` nullable, `pk` primary key, `->schema.table.col` foreign key.
  private serializeSchema(schema: SchemaTree): string {
    const lines: string[] = [];
    for (const ns of schema.schemas) {
      lines.push(`schema ${ns.name}:`);
      for (const table of ns.tables) {
        const cols = table.columns
          .map((c) => {
            const ref = c.references
              ? ` ->${c.references.schema}.${c.references.table}.${c.references.column}`
              : '';
            return `${c.name} ${c.dataType}${c.nullable ? '?' : ''}${c.isPrimaryKey ? ' pk' : ''}${ref}`;
          })
          .join(', ');
        lines.push(`  ${table.type} ${table.name}(${cols})`);
      }
    }
    if (!lines.length) return '(no user tables found)';
    const text = lines.join('\n');
    if (text.length <= MAX_SCHEMA_CHARS) return text;
    return (
      text.slice(0, MAX_SCHEMA_CHARS) +
      '\n… (schema truncated — ask the user to name the relevant tables)'
    );
  }

  private parse(raw: string): DbAssistResult {
    const obj = this.tryJson(raw);
    if (obj) {
      const sql = (obj.sql ?? '').trim();
      return {
        sql,
        explanation: (obj.explanation ?? '').trim(),
        mutation: this.isMutation(sql),
      };
    }
    // Fallback: a fenced ```sql block. Require the `sql` tag — a ```json wrapper must NOT
    // be captured here, or the { sql, … } object itself would land in the SQL editor.
    const fence = /```sql\s*([\s\S]*?)```/i.exec(raw);
    const sql = (fence?.[1] ?? '').trim();
    const explanation = raw.replaceAll(/```[\s\S]*?```/g, '').trim();
    return { sql, explanation, mutation: this.isMutation(sql) };
  }

  /**
   * Extract the { sql, explanation } object the model was asked to return. The model may
   * emit it bare, fenced as ```json, or inside a prose reply that itself contains braces
   * (e.g. a jsonb example) — which broke a naive first-brace/last-brace slice and leaked the
   * raw wrapper into the editor. So try each fenced block's contents first (isolated from the
   * surrounding prose), then the whole text, and accept the first that yields the shape.
   */
  private tryJson(raw: string): { sql?: string; explanation?: string } | null {
    const candidates: string[] = [];
    const fence = /```(?:json|sql)?\s*([\s\S]*?)```/gi;
    for (let m = fence.exec(raw); m; m = fence.exec(raw)) candidates.push(m[1]);
    candidates.push(raw);
    for (const candidate of candidates) {
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start === -1 || end <= start) continue;
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
          sql?: string;
          explanation?: string;
        };
        if (
          typeof parsed.sql === 'string' ||
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

  // UI hint only — the read-only transaction is the real boundary. Strips leading
  // comments, reads the first keyword, and checks a CTE body for a writing statement.
  private isMutation(sql: string): boolean {
    if (!sql) return false;
    const head = sql
      .replace(/^[\s;]+/, '')
      .replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/, '')
      .trimStart();
    const first = /^"?([A-Za-z]+)/.exec(head)?.[1]?.toUpperCase();
    if (!first) return false;
    if (first === 'WITH') return WRITE_IN_CTE.test(sql);
    return !READ_LEADING.has(first);
  }
}
