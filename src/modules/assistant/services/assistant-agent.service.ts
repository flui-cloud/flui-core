import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CatalogService } from '../../catalog/services/catalog.service';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { AppManagementService } from '../../applications/services/app-management.service';
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
import { InfrastructureOperationsService } from '../../infrastructure/operations/infrastructure-operations.service';
import { PodDebugService } from '../../scaling/services/pod-debug.service';
import { BackupPoliciesService } from '../../backups/services/backup-policies.service';
import { BackupJobsService } from '../../backups/services/backup-jobs.service';
import { BackupStatusService } from '../../backups/services/backup-status.service';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { FullMigrationService } from '../../full-migration/services/full-migration.service';
import { collectHosts, findUnverifiedUrls } from './url-guard.util';
import { McpScopeResolver } from '../../mcp/services/mcp-scope.resolver';
import { McpAuditRepository } from '../../mcp/repositories/mcp-audit.repository';
import { SCOPE_TIER } from '../../mcp/constants/mcp-scopes';
import { McpToolContext, ToolDef } from '../../mcp/tools/mcp-tool.util';
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
import { AssistantInferenceService } from './assistant-inference.service';
import { AssistantLlmService } from './assistant-llm.service';
import { AssistantGuardService, RouteMessage } from './assistant-guard.service';
import { KnowledgeService } from './knowledge.service';
import { AGENT_TOOL_NOTE } from '../policy';

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
 * Flui Assistant as a layered agent: scope gate → KB context → tool-use loop over
 * the shared tool registry. Read/plan tools run transparently; write/destructive
 * tools pause for an explicit confirmation (returned as a pending_action and resumed
 * with the approved tool-call ids). Tools execute in-process under the user's scopes.
 */
@Injectable()
export class AssistantAgentService {
  constructor(
    private readonly inference: AssistantInferenceService,
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
    private readonly operations: InfrastructureOperationsService,
    private readonly podDebug: PodDebugService,
    private readonly backupPolicies: BackupPoliciesService,
    private readonly backupJobs: BackupJobsService,
    private readonly backupStatus: BackupStatusService,
    private readonly appMigration: AppMigrationService,
    private readonly dbMigration: DbMigrationService,
    private readonly fullMigration: FullMigrationService,
    private readonly scheduledJobs: ScheduledJobsService,
    private readonly gateway: GatewayService,
    private readonly config: ConfigService,
  ) {}

  private destructiveEnabled(): boolean {
    return this.config.get<string>(DESTRUCTIVE_ENV_FLAG) === 'true';
  }

  async run(
    user: AuthenticatedUser,
    dto: AgentRequestDto,
    emit?: AgentEmitter,
  ): Promise<AgentResult> {
    const { endpoint } = await this.inference.resolveEndpoint(dto);
    const model = await this.inference.resolveModel(dto, endpoint);
    const ctx = this.buildContext(user);
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
    const tail = conversation.at(-1);
    const isResume = tail?.role === 'assistant' && !!tail.tool_calls?.length;
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
    if (isResume && tail.tool_calls) {
      const before = steps.length;
      await this.resolveToolCalls(
        tail.tool_calls,
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

  private isFailureResult(result: string): boolean {
    return /^(denied|refused|error|action denied)/i.test(result.trim());
  }

  /** Fresh write/destructive calls needing confirmation — minus ones already performed. */
  private async collectPending(
    toolCalls: ToolCall[],
    ctx: McpToolContext,
    approved: Set<string>,
    executed: Map<string, string>,
  ): Promise<PendingAction[]> {
    const pending: PendingAction[] = [];
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
      });
    }
    return pending;
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
    ctx: McpToolContext,
  ): Promise<{ label: string; groupKey: string }> {
    const id = typeof args.id === 'string' ? args.id : undefined;
    try {
      if ((name === 'app_uninstall' || name === 'app_delete') && id) {
        const app = await ctx.services.apps.findById(id);
        const install = await ctx.services.installer.findInstallByApplicationId(
          id,
          app.clusterId,
        );
        if (install) {
          return {
            label: `Uninstall ${install.displayName}`,
            groupKey: `install:${install.id}`,
          };
        }
        return { label: `Delete ${app.name}`, groupKey: `app:${id}` };
      }
      if (id) {
        const app = await ctx.services.apps.findById(id);
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
    ctx: McpToolContext;
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

  private buildContext(user: AuthenticatedUser): McpToolContext {
    return {
      user,
      scopes: this.scopes.resolve(user),
      // Destructive ops require BOTH server-wide enablement (MCP_ALLOW_DESTRUCTIVE) and,
      // when enabled, the per-action pending_action confirmation. Disabled by default:
      // the assistant refuses rather than offering a confirmation it cannot honour.
      allowDestructive: this.destructiveEnabled(),
      audit: this.audit,
      services: {
        catalog: this.catalog,
        installer: this.installer,
        apps: this.apps,
        deploy: this.deploy,
        management: this.management,
        releases: this.releases,
        sourceDeploy: this.sourceDeploy,
        templates: this.templates,
        repos: this.repos,
        github: this.github,
        githubAuth: this.githubAuth,
        githubManifest: this.githubManifest,
        loki: this.loki,
        traffic: this.traffic,
        alertEvents: this.alertEvents,
        clusters: this.clusters,
        operations: this.operations,
        podDebug: this.podDebug,
        backupPolicies: this.backupPolicies,
        backupJobs: this.backupJobs,
        backupStatus: this.backupStatus,
        appMigration: this.appMigration,
        dbMigration: this.dbMigration,
        fullMigration: this.fullMigration,
        scheduledJobs: this.scheduledJobs,
        gateway: this.gateway,
      },
    };
  }

  /** Tools the user is allowed to see, as OpenAI function schemas. */
  private toolsForUser(ctx: McpToolContext): ChatTool[] {
    return ALL_TOOLS.filter((d) => ctx.scopes.has(d.scope)).map(toOpenAiTool);
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
    ctx: McpToolContext,
    approved: Set<string>,
    conversation: ChatCompletionMessage[],
    steps: AgentToolStep[],
    pendUnapproved = true,
    executed: Map<string, string> = new Map(),
  ): Promise<PendingAction[]> {
    if (pendUnapproved) {
      const pending = await this.collectPending(
        toolCalls,
        ctx,
        approved,
        executed,
      );
      if (pending.length) return pending;
    }

    for (const tc of toolCalls) {
      const content = await this.execOrDeny(tc, ctx, approved, steps, executed);
      conversation.push({ role: 'tool', tool_call_id: tc.id, content });
    }
    return [];
  }

  /** A state-changing call the user did not approve is denied; everything else runs. */
  private async execOrDeny(
    tc: ToolCall,
    ctx: McpToolContext,
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
        await this.recordTool(ctx, tc.function.name, def, false, 'denied');
        steps.push({
          toolCallId: tc.id,
          name: tc.function.name,
          ok: false,
          error: 'denied by user',
        });
        return `DENIED by the user — '${tc.function.name}' was NOT executed and nothing changed. Tell the user it was cancelled; never claim it was done.`;
      }
    }
    return this.execOne(tc, ctx, steps, executed);
  }

  private async execOne(
    tc: ToolCall,
    ctx: McpToolContext,
    steps: AgentToolStep[],
    executed: Map<string, string>,
  ): Promise<string> {
    const name = tc.function.name;
    const def = findTool(name);
    if (!def) {
      steps.push({ toolCallId: tc.id, name, ok: false, error: 'unknown tool' });
      return `Error: unknown tool '${name}'.`;
    }
    if (!ctx.scopes.has(def.scope)) {
      await this.recordTool(ctx, name, def, false, 'missing scope');
      steps.push({
        toolCallId: tc.id,
        name,
        ok: false,
        error: 'missing scope',
      });
      return `Refused: missing required scope '${def.scope}'.`;
    }
    if (SCOPE_TIER[def.scope] === 'destructive' && !ctx.allowDestructive) {
      await this.recordTool(ctx, name, def, false, DESTRUCTIVE_DISABLED_REASON);
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
      args = z.object(def.inputSchema).parse(this.parseArgs(tc));
    } catch (error) {
      const message = describeError(error);
      await this.recordTool(ctx, name, def, false, message);
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
      const data = await def.run(args as never, ctx);
      await this.recordTool(ctx, name, def, true);
      // Full result → UI (artifact); a compact, bounded view → the model.
      steps.push({ toolCallId: tc.id, name, ok: true, result: data });
      executed.set(key, 'done');
      return this.modelView(def, data);
    } catch (error) {
      const message = describeError(error);
      await this.recordTool(ctx, name, def, true, message);
      steps.push({ toolCallId: tc.id, name, ok: false, error: message });
      return `Error: ${message}`;
    }
  }

  private async recordTool(
    ctx: McpToolContext,
    tool: string,
    def: ToolDef,
    allowed: boolean,
    error?: string,
  ): Promise<void> {
    await this.audit.record({
      userId: ctx.user.userId,
      tool: `assistant:${tool}`,
      scope: def.scope,
      allowed,
      error,
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
