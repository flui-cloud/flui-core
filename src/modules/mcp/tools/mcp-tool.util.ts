import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CatalogService } from '../../catalog/services/catalog.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { LokiQueryService } from '../../observability/services/loki-query.service';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { McpScope, SCOPE_TIER } from '../constants/mcp-scopes';

/** A tool result in MCP's content shape. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** The existing Nest services the thin tools delegate to (no new business logic). */
export interface McpServices {
  catalog: CatalogService;
  apps: ApplicationService;
  deploy: ApplicationDeployService;
  loki: LokiQueryService;
}

/** Per-request context shared by every tool registrar. */
export interface McpToolContext {
  user: AuthenticatedUser;
  scopes: Set<string>;
  allowDestructive: boolean;
  audit: McpAuditRepository;
  services: McpServices;
}

function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Runs a tool body behind the scope gate: refuses if the scope is not granted,
 * refuses destructive tools unless explicitly enabled, audits every outcome.
 */
export async function runGated(
  ctx: McpToolContext,
  tool: string,
  scope: McpScope,
  fn: () => Promise<unknown>,
): Promise<ToolResult> {
  if (!ctx.scopes.has(scope)) {
    await ctx.audit.record({
      userId: ctx.user.userId,
      tool,
      scope,
      allowed: false,
      error: 'missing scope',
    });
    return errorResult(`Refused: missing required scope '${scope}'.`);
  }

  if (SCOPE_TIER[scope] === 'destructive' && !ctx.allowDestructive) {
    await ctx.audit.record({
      userId: ctx.user.userId,
      tool,
      scope,
      allowed: false,
      error: 'destructive disabled',
    });
    return errorResult(
      'Refused: destructive operations are disabled on this server (set MCP_ALLOW_DESTRUCTIVE=true to enable).',
    );
  }

  try {
    const data = await fn();
    await ctx.audit.record({
      userId: ctx.user.userId,
      tool,
      scope,
      allowed: true,
    });
    return jsonResult(data);
  } catch (error) {
    const message = errMsg(error);
    await ctx.audit.record({
      userId: ctx.user.userId,
      tool,
      scope,
      allowed: true,
      error: message,
    });
    return errorResult(message);
  }
}
