import { Injectable } from '@nestjs/common';
import type { AgentRunContext } from './assistant-agent.service';
import { ActionCycleRoutes } from './action-cycle-routes.service';
import { McpAuditRepository } from '../../mcp/repositories/mcp-audit.repository';
import {
  assentInChat,
  proposalRefusalOf,
  waitMessage,
} from './agent-pause.util';
import { MCP_SCOPE, SCOPE_TIER } from '../../mcp/constants/mcp-scopes';
import { ToolDef, toolInputSchema } from '../../mcp/tools/mcp-tool.util';
import { findTool } from '../../mcp/tools/tool-registry';
import { describeError } from '../../shared/utils/error.util';
import { AgentToolStep, PendingAction } from '../interfaces/agent';
import { ChatCompletionMessage, ToolCall } from '../interfaces/chat-completion';
import { cacheKey, modelView, parseArgs, recordTool } from './tool-call.util';
import { READ_SURFACE_TOOL } from './surface-block.util';
import { AssistantPendingActionsService } from './assistant-pending-actions.service';

// Server-wide enablement for destructive (delete/uninstall) tools — same flag as the
// headless MCP server. Default off: the assistant refuses them and tells the user how
// to enable, instead of offering a confirmation it cannot honour.
const DESTRUCTIVE_DISABLED_MESSAGE =
  'Refused: destructive operations (delete/uninstall) are disabled on this server. An administrator must enable them by setting MCP_ALLOW_DESTRUCTIVE=true in the server configuration.';
const DESTRUCTIVE_DISABLED_REASON = 'destructive disabled';

/**
 * Dispatches one assistant turn's tool calls: read/plan tools run transparently,
 * write/destructive tools pause for an explicit confirmation via
 * `AssistantPendingActionsService`. Everything here runs under the caller's own
 * `AgentRunContext` (scopes, credential, audit); this service holds only the
 * collaborators the execution path itself needs, not the whole assistant's
 * dependency graph.
 */
@Injectable()
export class AssistantToolExecutionService {
  constructor(
    private readonly audit: McpAuditRepository,
    private readonly cycleRoutes: ActionCycleRoutes,
    private readonly pendingActions: AssistantPendingActionsService,
  ) {}

  /**
   * Resolve one assistant message's tool_calls.
   * - pendUnapproved=true (fresh calls): if any state-changing call still needs
   *   approval, return them all as pending and execute nothing, so the conversation
   *   keeps the unanswered assistant message for the resume.
   * - pendUnapproved=false (resume): the user already decided — execute approved
   *   calls and deny the rest; never re-prompt.
   */
  async resolveToolCalls(
    toolCalls: ToolCall[],
    ctx: AgentRunContext,
    approved: Set<string>,
    conversation: ChatCompletionMessage[],
    steps: AgentToolStep[],
    pendUnapproved = true,
    executed: Map<string, string> = new Map(),
  ): Promise<PendingAction[]> {
    const settledIds = new Set<string>();
    if (pendUnapproved) {
      const { pending, settled } = await this.pendingActions.collectPending(
        toolCalls,
        ctx,
        approved,
        executed,
      );
      // Written down *before* the early return, and that is the whole point:
      // the conversation is the only thing a resume gets back, so a call the
      // cycle settled has to be in it even when this turn stops for a card. The
      // step is what the person sees; the tool message is what the next turn
      // reads instead of asking again.
      for (const call of settled) {
        settledIds.add(call.toolCallId);
        steps.push({
          toolCallId: call.toolCallId,
          name: call.name,
          ok: call.ok,
          error: call.error,
          result: call.result,
        });
        conversation.push({
          role: 'tool',
          tool_call_id: call.toolCallId,
          content: call.content,
        });
      }
      if (pending.length) return pending;
    }

    for (const tc of toolCalls) {
      if (settledIds.has(tc.id)) continue;
      const content = await this.execOrDeny(tc, ctx, approved, steps, executed);
      conversation.push({ role: 'tool', tool_call_id: tc.id, content });
    }
    return [];
  }

  /** A state-changing call the user did not approve is denied; everything else runs. */
  private async execOrDeny(
    tc: ToolCall,
    ctx: AgentRunContext,
    approved: Set<string>,
    steps: AgentToolStep[],
    executed: Map<string, string>,
  ): Promise<string> {
    const def = findTool(tc.function.name);
    if (def && ctx.scopes.has(def.scope)) {
      const tier = SCOPE_TIER[def.scope];
      if (tier === 'destructive' && !ctx.allowDestructive) {
        await recordTool(
          this.audit,
          ctx,
          tc.function.name,
          def,
          false,
          DESTRUCTIVE_DISABLED_REASON,
          { args: parseArgs(tc) },
        );
        steps.push({
          toolCallId: tc.id,
          name: tc.function.name,
          ok: false,
          error: DESTRUCTIVE_DISABLED_REASON,
        });
        return DESTRUCTIVE_DISABLED_MESSAGE;
      }
      if (
        (tier === 'write' || tier === 'destructive') &&
        !approved.has(tc.id)
      ) {
        await recordTool(
          this.audit,
          ctx,
          tc.function.name,
          def,
          false,
          'denied',
          {
            args: parseArgs(tc),
          },
        );
        steps.push({
          toolCallId: tc.id,
          name: tc.function.name,
          ok: false,
          error: 'denied by user',
        });
        return `DENIED by the user — '${tc.function.name}' was NOT executed and nothing changed. Tell the user it was cancelled; never claim it was done.`;
      }
    }
    return this.execOne(tc, ctx, steps, executed, approved.has(tc.id));
  }

  /**
   * @param assented the person confirmed THIS call, with these arguments, in the
   * chat. It is what the action cycle's request is answered with when the call
   * turns out to need one — see the catch below.
   */
  private async execOne(
    tc: ToolCall,
    ctx: AgentRunContext,
    steps: AgentToolStep[],
    executed: Map<string, string>,
    assented = false,
  ): Promise<string> {
    const name = tc.function.name;

    // Special-cased ahead of the shared registry: its only data source is this
    // turn's own AgentRunContext.semanticSurface (see that field's doc comment
    // for why it cannot be a normal ToolDef in ALL_TOOLS). Only ever offered by
    // toolsForUser() when a Surface is actually present, but a model could still
    // name it on a turn where the Surface was rejected mid-flight (e.g. a stale
    // revision) — answer honestly rather than pretending the tool doesn't exist.
    if (name === READ_SURFACE_TOOL) {
      return this.execReadSurface(tc, ctx, steps);
    }

    const def = findTool(name);
    if (!def) {
      steps.push({ toolCallId: tc.id, name, ok: false, error: 'unknown tool' });
      return `Error: unknown tool '${name}'.`;
    }
    if (!ctx.scopes.has(def.scope)) {
      await recordTool(this.audit, ctx, name, def, false, 'missing scope', {
        args: parseArgs(tc),
      });
      steps.push({
        toolCallId: tc.id,
        name,
        ok: false,
        error: 'missing scope',
      });
      return `Refused: missing required scope '${def.scope}'.`;
    }
    if (SCOPE_TIER[def.scope] === 'destructive' && !ctx.allowDestructive) {
      await recordTool(
        this.audit,
        ctx,
        name,
        def,
        false,
        DESTRUCTIVE_DISABLED_REASON,
        {
          args: parseArgs(tc),
        },
      );
      steps.push({
        toolCallId: tc.id,
        name,
        ok: false,
        error: DESTRUCTIVE_DISABLED_REASON,
      });
      return DESTRUCTIVE_DISABLED_MESSAGE;
    }

    let args: unknown;
    try {
      args = toolInputSchema(def.inputSchema).parse(parseArgs(tc));
    } catch (error) {
      const message = describeError(error);
      await recordTool(this.audit, ctx, name, def, false, message, {
        args: parseArgs(tc),
      });
      steps.push({ toolCallId: tc.id, name, ok: false, error: message });
      return `Error: invalid arguments — ${message}`;
    }

    // Idempotency / anti-loop, keyed by name+args:
    //  - read/plan: an identical call returns identical data → answer from it;
    //  - write/destructive: an identical call already performed must NEVER run
    //    again (would install/delete twice), including across the approve/resume.
    const tier = SCOPE_TIER[def.scope];
    const mutating = tier === 'write' || tier === 'destructive';
    const key = cacheKey(name, parseArgs(tc));
    if (executed.has(key)) {
      return mutating
        ? `'${name}' with these arguments was ALREADY performed in this conversation; it was NOT run again. Tell the user it is already done — do not repeat it or claim a new change.`
        : `You already called ${name} with these arguments and have the result above. Do not call it again — answer the user from what you have.`;
    }

    try {
      return await this.callTool({
        tc,
        ctx,
        def,
        args,
        steps,
        executed,
        assented,
      });
    } catch (error) {
      const message = describeError(error);
      await recordTool(this.audit, ctx, name, def, true, message, { args });
      steps.push({ toolCallId: tc.id, name, ok: false, error: message });
      return `Error: ${message}`;
    }
  }

  /**
   * `read_surface`: hand back the full, already-accepted Semantic Surface for this
   * turn — nothing this returns was not already sent to the model in compact form
   * as the digest (§8.4); this is the same object, just untrimmed. Never routes
   * through `ctx.api` (there is nothing to fetch, it is already on the context),
   * so none of the scope/tier/idempotency machinery `execOne`'s normal path runs
   * applies here.
   */
  private async execReadSurface(
    tc: ToolCall,
    ctx: AgentRunContext,
    steps: AgentToolStep[],
  ): Promise<string> {
    const name = READ_SURFACE_TOOL;
    // Uses ONBOARDING_READ purely as an audit-row placeholder scope: like that
    // scope's own doc comment says of itself, this is "identical for every
    // credential on an installation... nothing here to narrow by scoping it" —
    // the same is true of reading back your own turn's own Surface.
    const auditDef: ToolDef = {
      name,
      description: "Read this turn's full Semantic Surface snapshot.",
      inputSchema: {},
      scope: MCP_SCOPE.ONBOARDING_READ,
      run: async () => undefined,
    };
    if (!ctx.semanticSurface) {
      await recordTool(
        this.audit,
        ctx,
        name,
        auditDef,
        false,
        'no surface on this turn',
      );
      steps.push({
        toolCallId: tc.id,
        name,
        ok: false,
        error: 'no surface on this turn',
      });
      return 'There is no Semantic Surface on this turn — the interface either sent none, or it was rejected (e.g. a stale revision). Answer from the conversation alone.';
    }
    const json = JSON.stringify(ctx.semanticSurface);
    await recordTool(this.audit, ctx, name, auditDef, true, undefined, {
      data: { surfaceId: ctx.semanticSurface.surface.id },
    });
    steps.push({ toolCallId: tc.id, name, ok: true });
    return json;
  }

  /**
   * The call itself, and the one refusal that is not a failure.
   *
   * A tool of this surface meets the action cycle like any other agent's call —
   * the loopback request declares the surface it came through, so a decorated
   * route stops it and raises a request instead of an effect. What happens next
   * is the whole point of assimilating the two surfaces: the person is already
   * here, and they already said yes to this exact call in the chat. That yes is
   * recorded as the answer to the request — through the API's own decision
   * route, on their own credential — and the identical call is retried once,
   * which is what executes it.
   *
   * **Answering for somebody is only legitimate where they were shown what they
   * are answering**, and that is what `cycleRoutes.reaches` is doing in the
   * condition below rather than an optimisation. The card the person clicked
   * carries the cycle's request — its sentence, and the fact that a price is
   * attached — precisely for the calls this predicate admits, because it is the
   * same predicate that decided to raise the request before the card was built.
   * For anything it does not admit, no request was ever shown, so no answer may
   * be given on their behalf: the wait stands and is reported as a wait, which
   * is also what a chat driven by an agent credential gets.
   *
   * So it is **one question, asked once**, and unlike the confirmation this
   * surface had before, it leaves a row: what was asked, in the sentence the
   * cycle wrote, answered by whom and when.
   */
  private async callTool(
    call: {
      tc: ToolCall;
      ctx: AgentRunContext;
      def: ToolDef;
      args: unknown;
      steps: AgentToolStep[];
      executed: Map<string, string>;
      assented: boolean;
    },
    retried = false,
  ): Promise<string> {
    const { tc, ctx, def, args, steps, executed, assented } = call;
    const name = tc.function.name;
    const key = cacheKey(name, parseArgs(tc));
    try {
      const data = await def.run(args as never, ctx);
      await recordTool(this.audit, ctx, name, def, true, undefined, {
        args,
        data,
      });
      // Full result → UI (artifact); a compact, bounded view → the model.
      steps.push({ toolCallId: tc.id, name, ok: true, result: data });
      executed.set(key, 'done');
      return modelView(def, data);
    } catch (error) {
      const refusal = proposalRefusalOf(error);
      if (!refusal) throw error;
      const answered =
        assented &&
        !retried &&
        this.cycleRoutes.reaches(def.routes) &&
        !!ctx.asPerson &&
        (await assentInChat(ctx.asPerson, refusal));
      if (answered) {
        return this.callTool(
          { tc, ctx, def, args, steps, executed, assented: false },
          true,
        );
      }
      const message = waitMessage(refusal);
      // Recorded as a turn that stopped to ask, exactly as the MCP surface
      // records it: `allowed` stays true because the tool was granted and the
      // scope let it through — nothing was denied, somebody was asked. The
      // refusal is handed over rather than the message, because what the
      // register classifies on is the outcome column and the request this turn
      // raised — never the text.
      await recordTool(this.audit, ctx, name, def, true, message, {
        args,
        waiting: refusal,
      });
      steps.push({ toolCallId: tc.id, name, ok: false, error: message });
      // NOT written to `executed`: nothing ran, and the person's answer has to
      // be able to make the identical call run later.
      return message;
    }
  }
}
