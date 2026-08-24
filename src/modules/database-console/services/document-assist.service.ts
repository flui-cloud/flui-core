import { Injectable } from '@nestjs/common';
import {
  AssistantInferenceService,
  InferenceSelection,
} from '../../assistant/services/assistant-inference.service';
import { AssistantLlmService } from '../../assistant/services/assistant-llm.service';
import { DbConnectionResolveInput } from '../interfaces/db-connection';
import { EngineKnowledgeService } from '../knowledge/engine-knowledge.service';
import { DocumentQueryService } from './document-query.service';
import { DbConsoleAuditService } from './db-console-audit.service';

export interface DocAssistTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DocAssistResult {
  /** A single runnable mongosh statement, e.g. db.users.find({ active: true }). */
  shell: string;
  explanation: string;
  /** True when the statement writes/destroys — the UI gates it behind a confirm. */
  mutation: boolean;
}

export interface DocAssistScope {
  database?: string;
  collection?: string;
}

// Shell methods that change data — used for the UI mutation hint only (the read-only
// gate on /doc/shell is the real boundary). First match anywhere in the statement.
const WRITE_METHODS = [
  'insertOne',
  'insertMany',
  'insert',
  'updateOne',
  'updateMany',
  'update',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'delete',
  'remove',
  'dropDatabase',
  'dropIndexes',
  'dropIndex',
  'drop',
  'createCollection',
  'createIndexes',
  'createIndex',
  'create',
  'renameCollection',
  'bulkWrite',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'findAndModify',
];
const WRITE_METHOD = new RegExp(
  String.raw`\.(${WRITE_METHODS.join('|')})\s*\(`,
);

/**
 * Data-blind NL→mongosh copilot for the document console. It receives the curated
 * Mongo/FerretDB KB + a data-blind structure summary (collection NAMES in the active
 * database, and the active collection's inferred field paths + types — never document
 * values) and returns a single runnable mongosh statement. Reuses the Flui Assistant's
 * inference plumbing verbatim, exactly like the SQL and key-value copilots.
 */
@Injectable()
export class DocumentAssistService {
  constructor(
    private readonly inference: AssistantInferenceService,
    private readonly llm: AssistantLlmService,
    private readonly knowledge: EngineKnowledgeService,
    private readonly docs: DocumentQueryService,
    private readonly audit: DbConsoleAuditService,
  ) {}

  async assist(
    input: DbConnectionResolveInput,
    prompt: string,
    conversation: DocAssistTurn[] = [],
    selection: InferenceSelection = {},
    scope: DocAssistScope = {},
  ): Promise<DocAssistResult> {
    const { endpoint } = await this.inference.resolveEndpoint(selection, {
      userId: input.fluiUserId,
    });
    const model = await this.inference.resolveModel(selection, endpoint);

    const system = [
      // FerretDB speaks the MongoDB wire protocol — the KB is Mongo/mongosh.
      this.knowledge.getSystemContext('ferretdb'),
      '# Live structure (data-blind: names + inferred types only, never values)',
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
      max_tokens: 700,
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

  // Names + inferred field types only — never document contents. Best-effort: any
  // introspection failure just yields a thinner context, never a broken assist.
  private async serializeStructure(
    input: DbConnectionResolveInput,
    scope: DocAssistScope,
  ): Promise<string> {
    const lines: string[] = [];
    const database = scope.database;
    if (!database) {
      return '(no database selected — ask the user which database/collection to target)';
    }
    lines.push(`- database: ${database}`);
    try {
      const collections = await this.docs.collections(input, database);
      const names = collections.map((c) => c.name);
      lines.push(
        names.length
          ? `- collections: ${names.join(', ')}`
          : '- collections: (none)',
      );
    } catch {
      lines.push('- collections: (unavailable)');
    }
    if (scope.collection) {
      lines.push(`- active collection: ${scope.collection}`);
      try {
        const fields = await this.docs.fields(
          input,
          database,
          scope.collection,
        );
        if (fields.length) {
          lines.push('- inferred fields (path: types):');
          for (const f of fields.slice(0, 200)) {
            lines.push(`    ${f.path}: ${f.types.join(' | ')}`);
          }
        }
      } catch {
        lines.push('- inferred fields: (unavailable)');
      }
    }
    return lines.join('\n');
  }

  private parse(raw: string): DocAssistResult {
    // Clean JSON is authoritative — trust its shell even when it's intentionally EMPTY
    // (a refusal or a "tell me more"). The prose fallbacks below must never resurrect a
    // statement from an empty shell, or the JSON blob itself ends up as a fake "command".
    const obj = this.tryJson(raw);
    if (obj && typeof obj.shell === 'string') {
      const shell = obj.shell.trim();
      return {
        shell,
        explanation: (obj.explanation ?? '').trim(),
        mutation: WRITE_METHOD.test(shell),
      };
    }

    // No parseable JSON — best-effort extraction from imperfect output.
    let shell = this.extractField(raw, 'shell');
    let explanation = this.extractField(raw, 'explanation');
    if (!explanation) {
      explanation = raw.replaceAll(/```[\s\S]*?```/g, '').trim();
    }
    if (!shell) {
      const fence = /```(?:js|javascript|mongosh|mongo)?\s*([\s\S]*?)```/i.exec(
        raw,
      );
      if (fence) shell = fence[1].trim();
    }
    if (!shell) shell = this.extractDbLine(raw);
    // A JSON object is never a runnable statement — never let a blob become the "shell".
    if (shell.startsWith('{')) shell = '';
    if (shell && explanation.includes(shell)) {
      explanation = explanation.replace(shell, '').trim();
    }

    return { shell, explanation, mutation: WRITE_METHOD.test(shell) };
  }

  private extractDbLine(text: string): string {
    for (const rawLine of text.split('\n')) {
      const line = rawLine
        .trim()
        .replace(/^[`>*\-\d.)\s]+/, '')
        .replace(/`+$/, '')
        .trim();
      if (
        /^db\b/.test(line) ||
        /^show (dbs|databases|collections|tables)$/i.test(line)
      ) {
        return line;
      }
    }
    return '';
  }

  private extractField(raw: string, key: string): string {
    const m = new RegExp(
      String.raw`"${key}"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"`,
    ).exec(raw);
    if (!m) return '';
    try {
      return (JSON.parse(`"${m[1]}"`) as string).trim();
    } catch {
      return m[1].trim();
    }
  }

  private tryJson(
    raw: string,
  ): { shell?: string; explanation?: string } | null {
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
        shell?: string;
        explanation?: string;
      };
      if (
        typeof parsed.shell === 'string' ||
        typeof parsed.explanation === 'string'
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}
