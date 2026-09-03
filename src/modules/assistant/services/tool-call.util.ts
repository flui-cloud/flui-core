import { ToolCall } from '../interfaces/chat-completion';
import { ToolDef } from '../../mcp/tools/mcp-tool.util';
import { McpAuditRepository } from '../../mcp/repositories/mcp-audit.repository';
import { ProposalRefusal } from '../../action-cycle/action-cycle.core';
import { waitingAuditRow } from './agent-pause.util';
import {
  redactToolArgs,
  startedOperationId,
} from '../../mcp/audit/tool-arg-redaction';
import type { AgentRunContext } from './assistant-agent.service';

// Cap what one tool result contributes to the model's context (~a few k tokens),
// so bulky outputs (logs, long lists) can never overflow the context window.
const MAX_TOOL_RESULT_CHARS = 6000;

/** Stable identity for a tool call (name + key-sorted args) used to dedupe reads. */
export function cacheKey(name: string, args: unknown): string {
  const obj = (args && typeof args === 'object' ? args : {}) as Record<
    string,
    unknown
  >;
  const sorted = Object.keys(obj)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
  return `${name}:${JSON.stringify(sorted)}`;
}

/** The bounded, model-facing text for a tool result (compact projection + hard cap). */
export function modelView(def: ToolDef, data: unknown): string {
  const view = def.forModel ? def.forModel(data) : data;
  const text = JSON.stringify(view);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_TOOL_RESULT_CHARS) +
    ' …[truncated — full result shown to the user]'
  );
}

export function parseArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}');
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The one audit write every tool-call path makes, whichever service is dispatching:
 * `AssistantPendingActionsService` (collectPending/raiseRequest) and
 * `AssistantToolExecutionService` (execOne/execOrDeny/callTool/execReadSurface) both
 * call this — a pure function taking `audit` explicitly rather than a shared base
 * class or a service each has to inject the other to reach.
 */
export async function recordTool(
  audit: McpAuditRepository,
  ctx: AgentRunContext,
  tool: string,
  def: ToolDef,
  allowed: boolean,
  error?: string,
  call?: { args?: unknown; data?: unknown; waiting?: ProposalRefusal },
): Promise<void> {
  await audit.record({
    userId: ctx.user.userId,
    actor: ctx.actor,
    tool: `assistant:${tool}`,
    // Said, not left to be inferred from the tool prefix: the column exists so
    // a row can name the surface it came through, and a row that leaves it
    // null is indistinguishable from one written before the column did.
    surface: 'assistant',
    scope: def.scope,
    allowed,
    error,
    // A turn stopped by the cycle is not a call that did nothing: without
    // these two the register reads it as `no-operation` — "there was nothing
    // to permit" — when the fact is "somebody is being asked".
    ...waitingAuditRow(call?.waiting),
    // The raw arguments are the model's, and on this surface they arrive
    // before validation — so they go through the same redactor as the MCP
    // side, which is fail-closed on anything its schema does not prove is
    // drawn from a set written in the source.
    args: redactToolArgs(def.inputSchema, call?.args),
    operationId: startedOperationId(call?.data),
    semanticSurfaceRef: ctx.semanticSurfaceRef,
  });
}
