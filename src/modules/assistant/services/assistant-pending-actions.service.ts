import { Injectable } from '@nestjs/common';
import type { AgentRunContext } from './assistant-agent.service';
import { ActionCycleRoutes } from './action-cycle-routes.service';
import { McpAuditRepository } from '../../mcp/repositories/mcp-audit.repository';
import {
  isStandingRefusal,
  proposalRefusalOf,
  standingRefusalMessage,
  waitMessage,
} from './agent-pause.util';
import { SCOPE_TIER } from '../../mcp/constants/mcp-scopes';
import { ToolDef, toolInputSchema } from '../../mcp/tools/mcp-tool.util';
import { findTool } from '../../mcp/tools/tool-registry';
import { describeError } from '../../shared/utils/error.util';
import { PendingAction } from '../interfaces/agent';
import { ToolCall } from '../interfaces/chat-completion';
import { ChatActionRequest, chatActionRequest } from './action-cycle-reach';
import { cacheKey, modelView, parseArgs, recordTool } from './tool-call.util';
import { describePending } from './assistant-turn.util';

/**
 * A call the cycle settled while it was being asked about, so there is nothing
 * left to confirm.
 *
 * Two of the cycle's four answers land here and they are opposites — it ran
 * because a yes already covered it, or it will never run because a no already
 * stands — and what they share is the thing that matters to the loop: no card,
 * and a result that has to be written down. Distinct from "no request" on
 * purpose: that one means nothing to confirm *because the cycle never looks at
 * this call*, which is the chat's own question, not the cycle's.
 */
export interface SettledCall {
  toolCallId: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** The tool message for the transcript — the only thing that survives a resume. */
  content: string;
}

/**
 * Decides which of a turn's write/destructive tool calls need an explicit
 * confirmation card, and asks the action cycle its question for each one — the
 * step before `AssistantToolExecutionService` actually runs anything.
 */
@Injectable()
export class AssistantPendingActionsService {
  constructor(
    private readonly audit: McpAuditRepository,
    private readonly cycleRoutes: ActionCycleRoutes,
  ) {}

  /**
   * Fresh write/destructive calls needing confirmation — and the ones the cycle
   * settled instead, which need writing down rather than confirming.
   */
  async collectPending(
    toolCalls: ToolCall[],
    ctx: AgentRunContext,
    approved: Set<string>,
    executed: Map<string, string>,
  ): Promise<{ pending: PendingAction[]; settled: SettledCall[] }> {
    const pending: PendingAction[] = [];
    const settled: SettledCall[] = [];
    for (const tc of toolCalls) {
      const def = findTool(tc.function.name);
      if (!def || !ctx.scopes.has(def.scope)) continue;
      const tier = SCOPE_TIER[def.scope];
      if (tier !== 'write' && tier !== 'destructive') continue;
      // A disabled destructive op cannot run — never offer a confirmation for it;
      // execOrDeny refuses it deterministically with the enable-via-env message.
      if (tier === 'destructive' && !ctx.allowDestructive) continue;
      if (approved.has(tc.id)) continue;
      const args = parseArgs(tc);
      // Already performed earlier? Don't ask again — let it fall through to be
      // blocked as a duplicate instead of a second confirmation prompt.
      if (executed.has(cacheKey(tc.function.name, args))) {
        continue;
      }
      const answer = await this.raiseRequest(tc, def, ctx, executed, approved);
      // The cycle answered this call outright — it ran under a yes the person
      // had already given, or it stands refused under a no they had already
      // given. Either way there is nothing to ask; see raiseRequest.
      if (answer?.kind === 'settled') {
        settled.push(answer.settled);
        continue;
      }
      const { label, groupKey } = await describePending(
        tc.function.name,
        args,
        ctx,
      );
      pending.push({
        toolCallId: tc.id,
        name: tc.function.name,
        arguments: args,
        tier,
        label,
        groupKey,
        request: answer?.request,
      });
    }
    return { pending, settled };
  }

  /**
   * Ask the cycle its question *now*, so the card carries it.
   *
   * The chat used to confirm first and meet the cycle afterwards, on the
   * resume, where it answered `once` for the person — who had therefore agreed
   * to a sentence nobody had shown them, and to a price nobody had mentioned.
   * They are the same question, so it is asked once, here, in the cycle's own
   * words, and the click answers the request it came from.
   *
   * **Making the call is how the question gets asked, and it is why the reach
   * test has to hold first.** Every route this tool can land on carries
   * `@ActionCycle`, so the guard refuses the call and raises a request instead
   * of letting anything happen — for these tools the pause *is* the effect.
   * Where that is not true nothing is called at all, and the chat keeps the
   * card it always had.
   *
   * **The cycle has four answers and the chat now presents all four.** It
   * raises a request (the card carries it); it lets the call through under a
   * yes already given — a request for these very arguments approved on the
   * requests page, or a standing concession, which this surface *can* hold
   * because `actorOf` gives it the fixed identity `surface:assistant`; it
   * refuses outright because a no to these very arguments already stands; or it
   * does not look at this call at all, and the chat keeps its own question.
   *
   * The two middle answers are settled: no card, and — this is the part that
   * was missing — a step and a tool message, because a turn that returns a card
   * for the *other* calls writes nothing else down, and an effect nobody wrote
   * down is reported as denied on the resume and done twice if the model tries
   * again.
   */
  private async raiseRequest(
    tc: ToolCall,
    def: ToolDef,
    ctx: AgentRunContext,
    executed: Map<string, string>,
    approved: Set<string>,
  ): Promise<
    | { kind: 'raised'; request: ChatActionRequest }
    | { kind: 'settled'; settled: SettledCall }
    | undefined
  > {
    if (!this.cycleRoutes.reaches(def.routes)) return undefined;
    const name = tc.function.name;
    let args: unknown;
    try {
      args = toolInputSchema(def.inputSchema).parse(parseArgs(tc));
    } catch {
      // Invalid arguments never reach the API, so there is no request to raise.
      // execOne reports the schema failure in its own words a moment later.
      return undefined;
    }
    try {
      const data = await def.run(args as never, ctx);
      await recordTool(this.audit, ctx, name, def, true, undefined, {
        args,
        data,
      });
      // Both marks, together: `executed` stops the loop repeating it, and the
      // approval is what lets it reach that check instead of being reported to
      // the model as refused by a person who in fact allowed it.
      executed.set(cacheKey(name, parseArgs(tc)), 'done');
      approved.add(tc.id);
      return {
        kind: 'settled',
        settled: {
          toolCallId: tc.id,
          name,
          ok: true,
          result: data,
          content: modelView(def, data),
        },
      };
    } catch (error) {
      const refusal = proposalRefusalOf(error);
      if (refusal) {
        // Recorded exactly as the MCP surface records a stopped turn: `allowed`
        // stays true because nothing was denied — somebody was asked — and the
        // two columns come from the one helper, so the register can walk from
        // the question to the calls it came out of.
        await recordTool(
          this.audit,
          ctx,
          name,
          def,
          true,
          waitMessage(refusal),
          {
            args,
            waiting: refusal,
          },
        );
        return { kind: 'raised', request: chatActionRequest(refusal) };
      }
      if (isStandingRefusal(error)) {
        const message = standingRefusalMessage(describeError(error));
        // `allowed: false`, as the MCP surface records the same answer: the
        // scope handed the tool over and the cycle refused the call. The two
        // surfaces must not disagree about what a settled no looks like in the
        // register.
        await recordTool(this.audit, ctx, name, def, false, message, { args });
        return {
          kind: 'settled',
          settled: {
            toolCallId: tc.id,
            name,
            ok: false,
            error: message,
            content: message,
          },
        };
      }
      return undefined;
    }
  }
}
