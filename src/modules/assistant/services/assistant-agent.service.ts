import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CatalogService } from '../../catalog/services/catalog.service';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { AppManagementService } from '../../applications/services/app-management.service';
import { AppConfigService } from '../../applications/services/app-config.service';
import { ScheduledJobsService } from '../../applications/services/scheduled-jobs.service';
import { GatewayService } from '../../applications/services/gateway.service';
import { ApplicationReleaseService } from '../../applications/services/application-release.service';
import { ApplicationSourceDeployService } from '../../applications/services/application-source-deploy.service';
import { TemplatesService } from '../../templates/templates.service';
import { RepositoriesService } from '../../repositories/services/repositories.service';
import { GitHubOAuthService } from '../../repositories/services/github-oauth.service';
import { GithubAppUserAuthService } from '../../repositories/services/github-app-user-auth.service';
import { GithubAppManifestStateService } from '../../repositories/services/github-app-manifest-state.service';
import { LokiQueryService } from '../../observability/services/loki-query.service';
import { ApplicationTrafficService } from '../../observability/services/application-traffic.service';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { ClusterDnsZoneService } from '../../dns/services/cluster-dns-zone.service';
import { InfrastructureOperationsService } from '../../infrastructure/operations/infrastructure-operations.service';
import { PodDebugService } from '../../scaling/services/pod-debug.service';
import { BackupPoliciesService } from '../../backups/services/backup-policies.service';
import { BackupJobsService } from '../../backups/services/backup-jobs.service';
import { BackupStatusService } from '../../backups/services/backup-status.service';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { FullMigrationService } from '../../full-migration/services/full-migration.service';
import { MailReadinessService } from '../../mail/services/mail-readiness.service';
import { MailSendService } from '../../mail/services/mail-send.service';
import { MailSuppressionService } from '../../mail/services/mail-suppression.service';
import { collectHosts, findUnverifiedUrls } from './url-guard.util';
import { McpScopeResolver } from '../../mcp/services/mcp-scope.resolver';
import { isOfferedToGuest } from '../../mcp/services/sandbox-tool-visibility';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  ForwardedCredential,
  McpApiCaller,
  McpApiClient,
} from '../../mcp/services/mcp-api.client';
import { McpAuditRepository } from '../../mcp/repositories/mcp-audit.repository';
import { ProposalRefusal } from '../../action-cycle/action-cycle.core';
import { Actor } from '../../auth/utils/actor-context';
import { actorOf } from '../../auth/utils/actor.util';
import {
  assentInChat,
  didNotTakeEffect,
  isStandingRefusal,
  proposalRefusalOf,
  standingRefusalMessage,
  waitMessage,
  waitingAuditRow,
} from './agent-pause.util';
import { unansweredToolCalls } from './turn-transcript.util';
import {
  redactToolArgs,
  startedOperationId,
} from '../../mcp/audit/tool-arg-redaction';
import { SCOPE_TIER } from '../../mcp/constants/mcp-scopes';
import {
  McpToolContext,
  ToolDef,
  toolInputSchema,
} from '../../mcp/tools/mcp-tool.util';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import {
  ALL_TOOLS,
  findTool,
  toOpenAiTool,
} from '../../mcp/tools/tool-registry';
import { describeError } from '../../shared/utils/error.util';
import { DEFAULT_ASSISTANT_TEMPERATURE } from '../assistant.constants';
import { AgentRequestDto } from '../dto/agent-request.dto';
import {
  AgentResult,
  AgentToolStep,
  DocLink,
  OperationPending,
  PendingAction,
  UiAction,
} from '../interfaces/agent';
import { AgentEmitter } from '../interfaces/agent-events';
import {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatTool,
  ToolCall,
} from '../interfaces/chat-completion';
import { ChatActionRequest, chatActionRequest } from './action-cycle-reach';
import { ActionCycleRoutes } from './action-cycle-routes.service';
import { AssistantInferenceService } from './assistant-inference.service';
import { AssistantLlmService } from './assistant-llm.service';
import { AssistantGuardService, RouteMessage } from './assistant-guard.service';
import { KnowledgeService } from './knowledge.service';
import { AGENT_TOOL_NOTE } from '../policy';
import { principalFromUser } from '../../iam/interfaces/iam.types';

const MAX_ITERATIONS = 8;
// Server-wide enablement for destructive (delete/uninstall) tools — same flag as the
// headless MCP server. Default off: the assistant refuses them and tells the user how
// to enable, instead of offering a confirmation it cannot honour.
const DESTRUCTIVE_ENV_FLAG = 'MCP_ALLOW_DESTRUCTIVE';
const DESTRUCTIVE_DISABLED_MESSAGE =
  'Refused: destructive operations (delete/uninstall) are disabled on this server. An administrator must enable them by setting MCP_ALLOW_DESTRUCTIVE=true in the server configuration.';
const DESTRUCTIVE_DISABLED_REASON = 'destructive disabled';
// Hosts the agent may legitimately cite that are not Flui endpoints — kept tiny and
// extensible; anything else must be a tool/user source or a DB-verified endpoint.
const STATIC_EXTERNAL_HOSTS = new Set(['github.com', 'gitlab.com']);
// Cap what one tool result contributes to the model's context (~a few k tokens),
// so bulky outputs (logs, long lists) can never overflow the context window.
const MAX_TOOL_RESULT_CHARS = 6000;
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
interface SettledCall {
  toolCallId: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** The tool message for the transcript — the only thing that survives a resume. */
  content: string;
}
/**
 * Flui Assistant as a layered agent: scope gate → KB context → tool-use loop over
 * the shared tool registry. Read/plan tools run transparently; write/destructive
 * tools pause for an explicit confirmation (returned as a pending_action and resumed
 * with the approved tool-call ids). Tools execute in-process under the user's scopes.
 */
/**
 * The tool context the assistant loop runs on: everything a tool sees, plus the
 * one caller a tool never sees.
 *
 * `asPerson` is deliberately not on `McpToolContext`. A tool body holding a
 * caller that speaks as the person rather than as the agent would be a bypass
 * sitting in reach of every tool ever written; this way it exists only in the
 * loop, which is the only thing that ever needs it.
 */
type AgentRunContext = McpToolContext & { asPerson?: McpApiCaller };

@Injectable()
export class AssistantAgentService {
  constructor(
    private readonly inference: AssistantInferenceService,
    private readonly cycleRoutes: ActionCycleRoutes,
    private readonly llm: AssistantLlmService,
    private readonly guard: AssistantGuardService,
    private readonly knowledge: KnowledgeService,
    private readonly scopes: McpScopeResolver,
    private readonly audit: McpAuditRepository,
    private readonly catalog: CatalogService,
    private readonly installer: CatalogInstallerService,
    private readonly apps: ApplicationService,
    private readonly deploy: ApplicationDeployService,
    private readonly management: AppManagementService,
    private readonly appConfig: AppConfigService,
    private readonly releases: ApplicationReleaseService,
    private readonly sourceDeploy: ApplicationSourceDeployService,
    private readonly templates: TemplatesService,
    private readonly repos: RepositoriesService,
    private readonly github: GitHubOAuthService,
    private readonly githubAuth: GithubAppUserAuthService,
    private readonly githubManifest: GithubAppManifestStateService,
    private readonly loki: LokiQueryService,
    private readonly traffic: ApplicationTrafficService,
    private readonly alertEvents: AlertEventsService,
    private readonly clusters: ClustersService,
    private readonly clusterDnsZone: ClusterDnsZoneService,
    private readonly operations: InfrastructureOperationsService,
    private readonly podDebug: PodDebugService,
    private readonly backupPolicies: BackupPoliciesService,
    private readonly backupJobs: BackupJobsService,
    private readonly backupStatus: BackupStatusService,
    private readonly appMigration: AppMigrationService,
    private readonly dbMigration: DbMigrationService,
    private readonly fullMigration: FullMigrationService,
    private readonly mailReadiness: MailReadinessService,
    private readonly mailSend: MailSendService,
    private readonly mailSuppressions: MailSuppressionService,
    private readonly scheduledJobs: ScheduledJobsService,
    private readonly gateway: GatewayService,
    private readonly config: ConfigService,
    private readonly api: McpApiClient,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  private destructiveEnabled(): boolean {
    return this.config.get<string>(DESTRUCTIVE_ENV_FLAG) === 'true';
  }

  async run(
    user: AuthenticatedUser,
    dto: AgentRequestDto,
    emit?: AgentEmitter,
    credential: ForwardedCredential = {},
    actor?: Actor,
  ): Promise<AgentResult> {
    const { endpoint } = await this.inference.resolveEndpoint(dto, user);
    const model = await this.inference.resolveModel(dto, endpoint);
    // The same question the MCP surface asks before it builds a toolbox. Asked
    // here too because this is the other consumer of the same registry, and a
    // second path that filters differently is a second answer to give.
    const { isSandbox } = await this.policy.resolveAccess(
      principalFromUser(user),
    );
    const ctx = this.buildContext(user, credential, isSandbox, actor);
    const approved = new Set(dto.approvedToolCallIds ?? []);
    const conversation: ChatCompletionMessage[] = dto.messages.map((m) => ({
      role: m.role,
      content: m.content ?? null,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
      name: m.name,
    }));
    const steps: AgentToolStep[] = [];

    // The lean context (guardrails + binding only) carries every tool-continuation
    // iteration and the final synthesis — the KB corpus is dead weight once the model
    // is reasoning over tool results, and re-sending it each loop is what spikes
    // per-minute tokens on small models. Guardrails persist in both.
    const leanSystem: ChatCompletionMessage = {
      role: 'system',
      content: `${this.knowledge.getBaseContext()}\n\n${AGENT_TOOL_NOTE}`,
    };

    // A resume (the tail holds the tool_calls the user just decided on) is already
    // past its KB-grounded decision: skip the router LLM call (already on-topic) and
    // run lean throughout. A fresh turn routes once and gets the full KB corpus for
    // its first decision only.
    // Not "the last message proposes tool calls" any more: a turn can now come
    // back having answered some of its own calls and none of the others — see
    // turn-transcript.util.ts.
    const resuming = unansweredToolCalls(conversation);
    const isResume = resuming.length > 0;
    let firstSystem = leanSystem;
    // Doc links for the topics this turn is grounded in — surfaced on the final answer.
    // A resume already made its KB-grounded decision (no router call), so it carries none.
    let docLinks: DocLink[] = [];
    if (!isResume) {
      const turns = this.chatTurns(conversation);
      const route = await this.guard.route(
        endpoint,
        model,
        turns,
        this.knowledge.getIndexPrompt(),
      );
      if (route.offTopic) {
        const content = await this.guard.refusal(endpoint, model, turns);
        conversation.push({ role: 'assistant', content });
        return { type: 'message', content, steps, messages: conversation };
      }
      docLinks = this.knowledge.docLinksFor(route.sectionIds);
      firstSystem = {
        role: 'system',
        content: `${this.knowledge.getSystemContext(route.sectionIds)}\n\n${AGENT_TOOL_NOTE}`,
      };
    }

    // Idempotency across the whole conversation: a write/destructive action already
    // performed (in a prior turn, e.g. the approved install) must never run again —
    // small models re-propose the same action and would install/delete twice.
    const executed = this.executedWriteKeys(conversation);
    if (isResume) {
      const before = steps.length;
      await this.resolveToolCalls(
        resuming,
        ctx,
        approved,
        conversation,
        steps,
        false,
        executed,
      );
      this.emitSteps(emit, steps, before);
    }

    return this.runLoop({
      endpoint,
      model,
      dto,
      ctx,
      approved,
      conversation,
      steps,
      firstSystem,
      leanSystem,
      tools: this.toolsForUser(ctx),
      executed,
      docLinks,
      emit,
    });
  }

  /**
   * Keys (name+args) of write/destructive tool calls that already EXECUTED in this
   * conversation — an assistant tool_call whose tool result is not a denial/refusal/
   * error. Seeds the idempotency guard so an already-done action can't repeat.
   */
  private executedWriteKeys(
    conversation: ChatCompletionMessage[],
  ): Map<string, string> {
    const resultById = this.toolResultsById(conversation);
    const executed = new Map<string, string>();
    for (const m of conversation) {
      if (m.role !== 'assistant' || !m.tool_calls) continue;
      for (const tc of m.tool_calls) {
        if (this.wasExecutedMutation(tc, resultById)) {
          executed.set(
            this.cacheKey(tc.function.name, this.parseArgs(tc)),
            'done',
          );
        }
      }
    }
    return executed;
  }

  private toolResultsById(
    conversation: ChatCompletionMessage[],
  ): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of conversation) {
      if (m.role === 'tool' && m.tool_call_id) {
        map.set(m.tool_call_id, typeof m.content === 'string' ? m.content : '');
      }
    }
    return map;
  }

  /** True iff this tool_call is a write/destructive that already executed (not denied/failed). */
  private wasExecutedMutation(
    tc: ToolCall,
    resultById: Map<string, string>,
  ): boolean {
    const def = findTool(tc.function.name);
    if (!def) return false;
    const tier = SCOPE_TIER[def.scope];
    if (tier !== 'write' && tier !== 'destructive') return false;
    const result = resultById.get(tc.id);
    return result !== undefined && !this.isFailureResult(result);
  }

  /** Whether the transcript says this call left no effect — see didNotTakeEffect. */
  private isFailureResult(result: string): boolean {
    return didNotTakeEffect(result);
  }

  /**
   * Fresh write/destructive calls needing confirmation — and the ones the cycle
   * settled instead, which need writing down rather than confirming.
   */
  private async collectPending(
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
      const args = this.parseArgs(tc);
      // Already performed earlier? Don't ask again — let it fall through to be
      // blocked as a duplicate instead of a second confirmation prompt.
      if (executed.has(this.cacheKey(tc.function.name, args))) {
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
      const { label, groupKey } = await this.describePending(
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
      args = toolInputSchema(def.inputSchema).parse(this.parseArgs(tc));
    } catch {
      // Invalid arguments never reach the API, so there is no request to raise.
      // execOne reports the schema failure in its own words a moment later.
      return undefined;
    }
    try {
      const data = await def.run(args as never, ctx);
      await this.recordTool(ctx, name, def, true, undefined, { args, data });
      // Both marks, together: `executed` stops the loop repeating it, and the
      // approval is what lets it reach that check instead of being reported to
      // the model as refused by a person who in fact allowed it.
      executed.set(this.cacheKey(name, this.parseArgs(tc)), 'done');
      approved.add(tc.id);
      return {
        kind: 'settled',
        settled: {
          toolCallId: tc.id,
          name,
          ok: true,
          result: data,
          content: this.modelView(def, data),
        },
      };
    } catch (error) {
      const refusal = proposalRefusalOf(error);
      if (refusal) {
        // Recorded exactly as the MCP surface records a stopped turn: `allowed`
        // stays true because nothing was denied — somebody was asked — and the
        // two columns come from the one helper, so the register can walk from
        // the question to the calls it came out of.
        await this.recordTool(ctx, name, def, true, waitMessage(refusal), {
          args,
          waiting: refusal,
        });
        return { kind: 'raised', request: chatActionRequest(refusal) };
      }
      if (isStandingRefusal(error)) {
        const message = standingRefusalMessage(describeError(error));
        // `allowed: false`, as the MCP surface records the same answer: the
        // scope handed the tool over and the cycle refused the call. The two
        // surfaces must not disagree about what a settled no looks like in the
        // register.
        await this.recordTool(ctx, name, def, false, message, { args });
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

  /**
   * Resolve a human-readable label + a target groupKey for a pending action, so the
   * UI shows "Uninstall Immich" rather than a raw id, and collapses the several
   * components of one catalog install into a single confirmation. Best-effort: any
   * lookup failure falls back to the tool name + raw id.
   */
  private async describePending(
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

  /**
   * The tool-use loop. Read/plan tools run transparently; write/destructive pend.
   * Identical read calls are memoized for the whole turn (small models re-issue the
   * same app_list/app_logs over and over — observed 7×): a repeat is skipped (no
   * re-run, no duplicate UI step), and an iteration that adds no new step means the
   * model is only looping → break to a final, tool-less synthesis.
   */
  private async runLoop(state: {
    endpoint: InferenceEndpoint;
    model: string;
    dto: AgentRequestDto;
    ctx: AgentRunContext;
    approved: Set<string>;
    conversation: ChatCompletionMessage[];
    steps: AgentToolStep[];
    firstSystem: ChatCompletionMessage;
    leanSystem: ChatCompletionMessage;
    tools: ChatTool[];
    executed: Map<string, string>;
    docLinks: DocLink[];
    emit?: AgentEmitter;
  }): Promise<AgentResult> {
    const { endpoint, model, dto, ctx, approved, conversation, steps, emit } =
      state;
    const executed = state.executed;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const msg = await this.generate(
        endpoint,
        model,
        [i === 0 ? state.firstSystem : state.leanSystem, ...conversation],
        dto,
        state.tools,
        emit,
      );
      if (!msg) {
        return this.message(
          'No response from the inference endpoint.',
          steps,
          conversation,
        );
      }
      conversation.push(msg);
      if (!msg.tool_calls?.length) {
        const safe = await this.finalizeContent(
          msg.content ?? '',
          conversation,
          steps,
          endpoint,
          model,
          dto,
          state.leanSystem,
        );
        return this.message(safe, steps, conversation, state.docLinks);
      }
      const stepsBefore = steps.length;
      const pending = await this.resolveToolCalls(
        msg.tool_calls,
        ctx,
        approved,
        conversation,
        steps,
        true,
        executed,
      );
      this.emitSteps(emit, steps, stepsBefore);
      if (pending.length) {
        return {
          type: 'pending_action',
          pending,
          uiActions: this.collectUiActions(steps),
          steps,
          messages: conversation,
        };
      }
      // Every call this round was a cached repeat — the model is looping. Stop and
      // let it synthesize from what it already has.
      if (steps.length === stepsBefore) break;
    }

    // Force one final answer WITHOUT tools so the user gets a synthesis instead of a
    // dead-end (weaker models never stop calling tools on their own).
    const finalMsg = await this.generate(
      endpoint,
      model,
      [state.leanSystem, ...conversation],
      dto,
      undefined,
      emit,
    );
    if (finalMsg) conversation.push(finalMsg);
    const safeFinal = await this.finalizeContent(
      finalMsg?.content ?? '',
      conversation,
      steps,
      endpoint,
      model,
      dto,
      state.leanSystem,
    );
    return this.message(safeFinal, steps, conversation, state.docLinks);
  }

  /**
   * Deterministic last line of defence against a fabricated app URL: if the answer
   * names an app-endpoint host that never appeared in a tool result (the model
   * imitating a real URL it saw earlier), regenerate ONCE with the fact injected,
   * and as a final safety net strip any URL that still slips through. Keeps the
   * conversation history in sync so the bad draft cannot be parroted next turn.
   */
  private async finalizeContent(
    content: string,
    conversation: ChatCompletionMessage[],
    steps: AgentToolStep[],
    endpoint: InferenceEndpoint,
    model: string,
    dto: AgentRequestDto,
    leanSystem: ChatCompletionMessage,
  ): Promise<string> {
    if (!content) return content;
    const sources: string[] = [];
    for (const m of conversation) {
      if (
        (m.role === 'tool' || m.role === 'user') &&
        typeof m.content === 'string'
      ) {
        sources.push(m.content);
      }
    }
    for (const s of steps) {
      if (s.result !== undefined) sources.push(JSON.stringify(s.result));
    }
    const sourceHosts = collectHosts(sources);
    if (!(await this.unverifiedUrls(content, sourceHosts)).length) {
      return content;
    }

    // Must be a 'user' turn, not 'system': it follows the assistant draft, and
    // providers reject a system message after an assistant message.
    const constraint: ChatCompletionMessage = {
      role: 'user',
      content:
        'Your previous answer named an app endpoint URL that is not a real endpoint — you invented it. Never state an app URL you did not get from an app_get/app_list tool result. If the app has no endpoint configured (e.g. a failed or incomplete install), say so plainly instead of giving a URL. Rewrite your previous answer now, removing every unverified URL.',
    };
    const regenerated = await this.generate(
      endpoint,
      model,
      [leanSystem, ...conversation, constraint],
      dto,
      undefined,
      undefined,
    );

    // Take the rewrite if it is clean; otherwise strip any URL that still slips
    // through so a fabricated link can never reach the user.
    let safe = regenerated?.content || content;
    for (const url of await this.unverifiedUrls(safe, sourceHosts)) {
      safe = safe.split(url).join('[endpoint non disponibile]');
    }

    const lastAssistant = [...conversation]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (lastAssistant) lastAssistant.content = safe;
    return safe;
  }

  /**
   * URLs in `text` that are neither sourced (a host seen in a tool result / user
   * message), nor a known-safe external host, nor — verified against the source of
   * truth — a real app endpoint fqdn or catalog resolvedFqdn in the DB. Mode-agnostic:
   * it never reasons about the URL's shape, only whether the host actually exists.
   */
  private async unverifiedUrls(
    text: string,
    sourceHosts: Set<string>,
  ): Promise<string[]> {
    const allowed = new Set<string>(sourceHosts);
    for (const host of STATIC_EXTERNAL_HOSTS) allowed.add(host);
    const toVerify = [...collectHosts([text])].filter((h) => !allowed.has(h));
    if (toVerify.length) {
      const [endpoints, resolved] = await Promise.all([
        this.apps.filterKnownEndpointHosts(toVerify),
        this.installer.existingResolvedFqdns(toVerify),
      ]);
      for (const host of [...endpoints, ...resolved]) {
        allowed.add(host.toLowerCase());
      }
    }
    return findUnverifiedUrls(text, allowed);
  }

  /**
   * One model generation, returning the assembled assistant message. When `emit`
   * is present the call streams: text tokens flow out as `delta` events and the
   * tool-call fragments are reassembled; otherwise it's a single buffered call.
   */
  private async generate(
    endpoint: InferenceEndpoint,
    model: string,
    messages: ChatCompletionMessage[],
    dto: AgentRequestDto,
    tools: ChatTool[] | undefined,
    emit: AgentEmitter | undefined,
  ): Promise<ChatCompletionMessage | null> {
    const request: ChatCompletionRequest = {
      model,
      messages,
      temperature: dto.temperature ?? DEFAULT_ASSISTANT_TEMPERATURE,
      max_tokens: dto.maxTokens,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    };
    if (emit) {
      return this.llm.chatStream(endpoint, request, (text) =>
        emit({ type: 'delta', text }),
      );
    }
    const response = await this.llm.chat(endpoint, {
      ...request,
      stream: false,
    });
    return response.choices?.[0]?.message ?? null;
  }

  private emitSteps(
    emit: AgentEmitter | undefined,
    steps: AgentToolStep[],
    from: number,
  ): void {
    if (!emit) return;
    for (let i = from; i < steps.length; i++) {
      emit({ type: 'step', step: steps[i] });
    }
  }

  private message(
    content: string,
    steps: AgentToolStep[],
    messages: ChatCompletionMessage[],
    docLinks?: DocLink[],
  ): AgentResult {
    return {
      type: 'message',
      content,
      uiActions: this.collectUiActions(steps),
      operationPending: this.collectOperationPending(steps),
      docLinks: docLinks?.length ? docLinks : undefined,
      steps,
      messages,
    };
  }

  /** Pull any browser steps a tool returned this turn up to a typed top-level list. */
  private collectUiActions(steps: AgentToolStep[]): UiAction[] {
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
  private collectOperationPending(steps: AgentToolStep[]): OperationPending[] {
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

  private buildContext(
    user: AuthenticatedUser,
    credential: ForwardedCredential,
    isSandbox: boolean,
    driver?: Actor,
  ): AgentRunContext {
    return {
      user,
      // **An agent, whoever is driving.** What this context runs are tool calls
      // whose arguments a model wrote, and that is what the columns behind this
      // field are asked to tell apart — the register's question is "did she do
      // this, or did something acting for her", and until now the portal's
      // assistant answered "she did" for every write it performed. The key row
      // is the driver's when a key authenticated them, and the assistant's own
      // identity when nothing did.
      actor: actorOf(user, driver?.keyId, 'assistant'),
      // Same rule as the MCP surface: a converted tool talks to the API as the
      // person driving the chat, on the credential their own request carried.
      // The surface travels with it, which is what makes the action cycle treat
      // these calls as an agent's — see actor-surface.ts.
      api: this.api.for(credential, 'assistant'),
      // The same credential with NO surface declared: the person, not their
      // copilot. Exactly one thing is done on it — recording the person's
      // in-chat yes as an answer to the request the cycle raised — and it goes
      // through the API's own decision route, so the line that refuses an agent
      // answering its own request is on this path too.
      asPerson: this.api.for(credential),
      scopes: this.scopes.resolve(user, isSandbox),
      isSandbox,
      // Destructive ops require BOTH server-wide enablement (MCP_ALLOW_DESTRUCTIVE) and,
      // when enabled, the per-action pending_action confirmation. Disabled by default:
      // the assistant refuses rather than offering a confirmation it cannot honour.
      allowDestructive: this.destructiveEnabled(),
      surface: 'assistant',
      audit: this.audit,
    };
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
  private toolsForUser(ctx: AgentRunContext): ChatTool[] {
    return ALL_TOOLS.filter(
      (d) => ctx.scopes.has(d.scope) && (!ctx.isSandbox || isOfferedToGuest(d)),
    ).map(toOpenAiTool);
  }

  private chatTurns(conversation: ChatCompletionMessage[]): RouteMessage[] {
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
   * Resolve one assistant message's tool_calls.
   * - pendUnapproved=true (fresh calls): if any state-changing call still needs
   *   approval, return them all as pending and execute nothing, so the conversation
   *   keeps the unanswered assistant message for the resume.
   * - pendUnapproved=false (resume): the user already decided — execute approved
   *   calls and deny the rest; never re-prompt.
   */
  private async resolveToolCalls(
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
      const { pending, settled } = await this.collectPending(
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
        await this.recordTool(
          ctx,
          tc.function.name,
          def,
          false,
          DESTRUCTIVE_DISABLED_REASON,
          { args: this.parseArgs(tc) },
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
        await this.recordTool(ctx, tc.function.name, def, false, 'denied', {
          args: this.parseArgs(tc),
        });
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
    const def = findTool(name);
    if (!def) {
      steps.push({ toolCallId: tc.id, name, ok: false, error: 'unknown tool' });
      return `Error: unknown tool '${name}'.`;
    }
    if (!ctx.scopes.has(def.scope)) {
      await this.recordTool(ctx, name, def, false, 'missing scope', {
        args: this.parseArgs(tc),
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
      await this.recordTool(
        ctx,
        name,
        def,
        false,
        DESTRUCTIVE_DISABLED_REASON,
        {
          args: this.parseArgs(tc),
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
      args = toolInputSchema(def.inputSchema).parse(this.parseArgs(tc));
    } catch (error) {
      const message = describeError(error);
      await this.recordTool(ctx, name, def, false, message, {
        args: this.parseArgs(tc),
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
    const key = this.cacheKey(name, this.parseArgs(tc));
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
      await this.recordTool(ctx, name, def, true, message, { args });
      steps.push({ toolCallId: tc.id, name, ok: false, error: message });
      return `Error: ${message}`;
    }
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
    const key = this.cacheKey(name, this.parseArgs(tc));
    try {
      const data = await def.run(args as never, ctx);
      await this.recordTool(ctx, name, def, true, undefined, { args, data });
      // Full result → UI (artifact); a compact, bounded view → the model.
      steps.push({ toolCallId: tc.id, name, ok: true, result: data });
      executed.set(key, 'done');
      return this.modelView(def, data);
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
      await this.recordTool(ctx, name, def, true, message, {
        args,
        waiting: refusal,
      });
      steps.push({ toolCallId: tc.id, name, ok: false, error: message });
      // NOT written to `executed`: nothing ran, and the person's answer has to
      // be able to make the identical call run later.
      return message;
    }
  }

  private async recordTool(
    ctx: AgentRunContext,
    tool: string,
    def: ToolDef,
    allowed: boolean,
    error?: string,
    call?: { args?: unknown; data?: unknown; waiting?: ProposalRefusal },
  ): Promise<void> {
    await this.audit.record({
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
    });
  }

  /** Stable identity for a tool call (name + key-sorted args) used to dedupe reads. */
  private cacheKey(name: string, args: unknown): string {
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
  private modelView(def: ToolDef, data: unknown): string {
    const view = def.forModel ? def.forModel(data) : data;
    const text = JSON.stringify(view);
    if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
    return (
      text.slice(0, MAX_TOOL_RESULT_CHARS) +
      ' …[truncated — full result shown to the user]'
    );
  }

  private parseArgs(tc: ToolCall): Record<string, unknown> {
    try {
      const parsed = JSON.parse(tc.function.arguments || '{}');
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      return {};
    }
  }
}
