import { z } from 'zod';
import { ChatTool } from '../../assistant/interfaces/chat-completion';
import { ToolDef } from './mcp-tool.util';
import { CATALOG_TOOLS } from './catalog.tools';
import { SPEC_TOOLS } from './spec.tools';
import { APPLICATION_TOOLS } from './application.tools';
import { OBSERVABILITY_TOOLS } from './observability.tools';
import { INFRASTRUCTURE_TOOLS } from './infrastructure.tools';
import { REPO_TOOLS } from './repo.tools';
import { BACKUP_TOOLS } from './backup.tools';
import { MIGRATION_TOOLS } from './migration.tools';

/**
 * The single source of truth for Flui tools. Consumed by the MCP server (external
 * agents) and the Flui Assistant agent loop (in-process). A tool is written once.
 */
export const ALL_TOOLS: ToolDef[] = [
  ...CATALOG_TOOLS,
  ...SPEC_TOOLS,
  ...INFRASTRUCTURE_TOOLS,
  ...APPLICATION_TOOLS,
  ...OBSERVABILITY_TOOLS,
  ...REPO_TOOLS,
  ...BACKUP_TOOLS,
  ...MIGRATION_TOOLS,
];

export function findTool(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

// zod v4 emits JSON Schema keywords that OpenAI's function-schema validator rejects
// (it 400s the whole request, while Scaleway/Mistral tolerate them): a top-level
// "$schema", and "propertyNames" from z.record(). Strip them at any depth so one tool
// list works across every provider — "additionalProperties" stays, expressing the dict.
const UNSUPPORTED_SCHEMA_KEYS = ['$schema', 'propertyNames'];

function sanitizeToolSchema(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(sanitizeToolSchema);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of UNSUPPORTED_SCHEMA_KEYS) delete obj[key];
    for (const value of Object.values(obj)) sanitizeToolSchema(value);
  }
}

/** OpenAI function-calling schema for a tool (parameters = JSON Schema from zod). */
export function toOpenAiTool(def: ToolDef): ChatTool {
  const parameters = z.toJSONSchema(z.object(def.inputSchema)) as Record<
    string,
    unknown
  >;
  sanitizeToolSchema(parameters);
  return {
    type: 'function',
    function: { name: def.name, description: def.description, parameters },
  };
}
