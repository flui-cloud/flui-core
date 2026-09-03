import type { AgentRunContext } from './assistant-agent.service';
import { ALL_TOOLS, toOpenAiTool } from '../../mcp/tools/tool-registry';
import { isOfferedToGuest } from '../../mcp/services/sandbox-tool-visibility';
import { READ_SURFACE_TOOL } from './surface-block.util';
import {
  AgentResult,
  AgentToolStep,
  DocLink,
  OperationPending,
  UiAction,
} from '../interfaces/agent';
import { AgentEmitter } from '../interfaces/agent-events';
import { ChatCompletionMessage, ChatTool } from '../interfaces/chat-completion';
import { RouteMessage } from './assistant-guard.service';

export function emitSteps(
  emit: AgentEmitter | undefined,
  steps: AgentToolStep[],
  from: number,
): void {
  if (!emit) return;
  for (let i = from; i < steps.length; i++) {
    emit({ type: 'step', step: steps[i] });
  }
}

/** Pull any browser steps a tool returned this turn up to a typed top-level list. */
export function collectUiActions(steps: AgentToolStep[]): UiAction[] {
  const actions: UiAction[] = [];
  for (const s of steps) {
    const result = s.result as { uiAction?: UiAction } | undefined;
    if (result && typeof result === 'object' && result.uiAction) {
      actions.push(result.uiAction);
    }
  }
  return actions;
}

/**
 * Pull any async operation started this turn (a tool result carrying an operationId
 * that has NOT yet finished) up to a typed top-level list, so the UI can render a
 * non-blocking progress widget that polls it. Deterministic — keyed on the result
 * shape, never on the model's prose.
 */
export function collectOperationPending(
  steps: AgentToolStep[],
): OperationPending[] {
  const ops: OperationPending[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    const r = s.result as
      | { operationId?: string; done?: boolean; label?: string }
      | undefined;
    if (!r || typeof r !== 'object') continue;
    if (typeof r.operationId !== 'string' || !r.operationId) continue;
    if (r.done === true) continue;
    if (seen.has(r.operationId)) continue;
    seen.add(r.operationId);
    ops.push({
      operationId: r.operationId,
      label: r.label ?? s.name,
      name: s.name,
    });
  }
  return ops;
}

export function message(
  content: string,
  steps: AgentToolStep[],
  messages: ChatCompletionMessage[],
  docLinks?: DocLink[],
): AgentResult {
  return {
    type: 'message',
    content,
    uiActions: collectUiActions(steps),
    operationPending: collectOperationPending(steps),
    docLinks: docLinks?.length ? docLinks : undefined,
    steps,
    messages,
  };
}

export function chatTurns(
  conversation: ChatCompletionMessage[],
): RouteMessage[] {
  return conversation
    .filter(
      (m): m is ChatCompletionMessage & { content: string } =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Tools the user is allowed to see, as OpenAI function schemas.
 *
 * Two questions, not one, and the second is the one this surface used to skip:
 * the scope says how much of the toolbox, the fence says which of it a guest
 * would actually be answered with. `/assistant/v1/chat` is not open to a
 * guest today, so nothing leaked — but the day it opens, one filtered list
 * and one unfiltered list is exactly the kind of second path the whole move
 * to a single tool registry was meant to remove.
 */
export function toolsForUser(ctx: AgentRunContext): ChatTool[] {
  const tools = ALL_TOOLS.filter(
    (d) => ctx.scopes.has(d.scope) && (!ctx.isSandbox || isOfferedToGuest(d)),
  ).map(toOpenAiTool);
  // Not in ALL_TOOLS (see AgentRunContext.semanticSurface's own doc comment) —
  // offered only on a turn that actually carries a Surface, per vops's own
  // precedent: "a tool that always answers 'there is no surface' teaches a
  // model to stop asking".
  if (ctx.semanticSurface) {
    tools.push({
      type: 'function',
      function: {
        name: READ_SURFACE_TOOL,
        description:
          'The full Semantic Surface snapshot for what the user is looking at right now — everything the compact digest above may have omitted for length. Read-only, descriptive, never authoritative.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    });
  }
  return tools;
}

/**
 * Resolve a human-readable label + a target groupKey for a pending action, so the
 * UI shows "Uninstall Immich" rather than a raw id, and collapses the several
 * components of one catalog install into a single confirmation. Best-effort: any
 * lookup failure falls back to the tool name + raw id.
 */
export async function describePending(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentRunContext,
): Promise<{ label: string; groupKey: string }> {
  const id = typeof args.id === 'string' ? args.id : undefined;
  try {
    if ((name === 'app_uninstall' || name === 'app_delete') && id) {
      const app = await ctx.api.get<{
        name?: string;
        catalogInstallId?: string;
      }>(`/applications/${encodeURIComponent(id)}`);
      if (app.catalogInstallId) {
        const install = await ctx.api.get<{ displayName?: string }>(
          `/catalog/installs/${encodeURIComponent(app.catalogInstallId)}`,
        );
        return {
          label: `Uninstall ${install.displayName}`,
          groupKey: `install:${app.catalogInstallId}`,
        };
      }
      return { label: `Delete ${app.name}`, groupKey: `app:${id}` };
    }
    if (id) {
      const app = await ctx.api.get<{ name?: string }>(
        `/applications/${encodeURIComponent(id)}`,
      );
      const verb: Record<string, string> = {
        app_scale: `Scale ${app.name} to ${typeof args.replicas === 'number' ? args.replicas : '?'} replica(s)`,
        app_restart: `Restart ${app.name}`,
        app_stop: `Stop ${app.name}`,
        app_start: `Start ${app.name}`,
        app_deploy: `Redeploy ${app.name}`,
      };
      return {
        label: verb[name] ?? `${name} ${app.name}`,
        groupKey: `${name}:${id}`,
      };
    }
    if (name === 'app_install') {
      const dn = (args.displayName as string) ?? (args.slug as string) ?? '';
      return { label: `Install ${dn}`.trim(), groupKey: `install-new:${dn}` };
    }
    if (name === 'repo_connect' && typeof args.repository === 'string') {
      return {
        label: `Connect repository ${args.repository}`,
        groupKey: `repo:${args.repository}`,
      };
    }
  } catch {
    // fall through to the generic label
  }
  return { label: name, groupKey: id ? `${name}:${id}` : name };
}
