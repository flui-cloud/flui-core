import { z } from 'zod';
import { ChatTool } from '../../assistant/interfaces/chat-completion';
import { ToolDef, toolInputSchema } from './mcp-tool.util';
import { CATALOG_TOOLS } from './catalog.tools';
import { SPEC_TOOLS } from './spec.tools';
import { APPLICATION_TOOLS } from './application.tools';
import { OBSERVABILITY_TOOLS } from './observability.tools';
import { INFRASTRUCTURE_TOOLS } from './infrastructure.tools';
import { DNS_TOOLS } from './dns.tools';
import { REPO_TOOLS } from './repo.tools';
import { BACKUP_TOOLS } from './backup.tools';
import { MIGRATION_TOOLS } from './migration.tools';
import { CRON_TOOLS } from './cron.tools';
import { GATEWAY_TOOLS } from './gateway.tools';
import { MAIL_TOOLS } from './mail.tools';
import { VARIABLE_TOOLS } from './variables.tools';
import { CREDENTIAL_HANDOVER_TOOLS } from './credential-handover.tools';
import { IAM_TOOLS } from './iam.tools';
import { OPERATING_CONTEXT_TOOLS } from './operating-context.tools';
import { SELF_SERVICE_TOOLS } from './self-service.tools';
import { INFRASTRUCTURE_OPERATION_TOOLS } from './infrastructure-operations.tools';
import { SCALING_TOOLS } from './scaling.tools';

/**
 * The single source of truth for Flui tools. Consumed by the MCP server (external
 * agents) and the Flui Assistant agent loop (in-process). A tool is written once.
 */
export const ALL_TOOLS: ToolDef[] = [
  // First on purpose. `tools/list` is served in declaration order, and the one
  // thing an agent should read before it does anything to somebody's
  // installation is how that installation is run.
  ...OPERATING_CONTEXT_TOOLS,
  ...CATALOG_TOOLS,
  ...SPEC_TOOLS,
  ...INFRASTRUCTURE_TOOLS,
  ...INFRASTRUCTURE_OPERATION_TOOLS,
  ...SCALING_TOOLS,
  ...DNS_TOOLS,
  ...APPLICATION_TOOLS,
  ...OBSERVABILITY_TOOLS,
  ...SELF_SERVICE_TOOLS,
  ...REPO_TOOLS,
  ...BACKUP_TOOLS,
  ...MIGRATION_TOOLS,
  ...CRON_TOOLS,
  ...GATEWAY_TOOLS,
  ...MAIL_TOOLS,
  ...VARIABLE_TOOLS,
  ...CREDENTIAL_HANDOVER_TOOLS,
  ...IAM_TOOLS,
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
  const parameters = z.toJSONSchema(toolInputSchema(def.inputSchema)) as Record<
    string,
    unknown
  >;
  sanitizeToolSchema(parameters);
  return {
    type: 'function',
    function: { name: def.name, description: def.description, parameters },
  };
}
