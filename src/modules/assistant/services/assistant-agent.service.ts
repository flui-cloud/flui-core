import { Inject, Injectable, Logger } from '@nestjs/common';
import { destructiveToolsAllowed } from '../../mcp/constants/mcp-scopes';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CatalogService } from '../../catalog/services/catalog.service';
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
import { McpScopeResolver } from '../../mcp/services/mcp-scope.resolver';
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
import { Actor } from '../../auth/utils/actor-context';
import { actorOf } from '../../auth/utils/actor.util';
import { executedWriteKeys, unansweredToolCalls } from './turn-transcript.util';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { AgentRequestDto } from '../dto/agent-request.dto';
import { AgentResult, AgentToolStep, DocLink } from '../interfaces/agent';
import { AgentEmitter } from '../interfaces/agent-events';
import {
  ChatCompletionMessage,
  ChatTool,
  ToolCall,
} from '../interfaces/chat-completion';
import {
  AssistantInferenceService,
  guestBudgetMessage,
} from './assistant-inference.service';
import { AssistantGenerationService } from './assistant-generation.service';
import { AssistantGuardService } from './assistant-guard.service';
import {
  GUEST_KNOWLEDGE_CAP,
  KnowledgeCap,
  KnowledgeService,
  SystemPrompt,
  VISITOR_KNOWLEDGE_CAP,
} from './knowledge.service';
import { estimatePromptTokens } from './assistant-llm.service';
import { outputTokenLimit } from '../assistant.constants';
import { AGENT_TOOL_NOTE } from '../policy';
import { principalFromUser } from '../../iam/interfaces/iam.types';
import { SurfaceSnapshot } from '@flui-cloud/semantic-surface';
import { acceptTurnSurface } from './turn-surface.util';
import { renderSurfaceBlock, semanticSurfaceRef } from './surface-block.util';
import { AssistantToolExecutionService } from './assistant-tool-execution.service';
import {
  chatTurns,
  lastUserText,
  collectUiActions,
  emitSteps,
  message,
  toolsForUser,
} from './assistant-turn.util';
import { McpToolContext } from '../../mcp/tools/mcp-tool.util';

const MAX_ITERATIONS = 8;
const CLOSING_MAX_TOKENS = 1024;
const DEFAULT_OUTPUT_TOKENS = 2048;

const CLOSING_NOTE = {
  visitor:
    'The assistant time for this visit is almost used up, so this is your last answer in this conversation. Answer now from what you already have, briefly and in the language of the conversation, without calling tools. End with one short sentence saying that the assistant time for this visit is used up and that signing in gives them their own space with assistant time of its own.',
  guest:
    'The assistant time of this sandbox is almost used up, so this is your last answer in this conversation. Answer now from what you already have, briefly and in the language of the conversation, without calling tools. End with one short sentence saying that this sandbox has used its assistant time and that their own coding agent can carry on over MCP.',
};

type GuestRoom = 'loop' | 'closing' | 'none';

function systemMessages(prompt: SystemPrompt): ChatCompletionMessage[] {
  return [
    { role: 'system', content: prompt.stable },
    { role: 'system', content: prompt.turn },
  ];
}

function knowledgeCap(endpoint: InferenceEndpoint): KnowledgeCap | undefined {
  if (!endpoint.spender?.guest) return undefined;
  return endpoint.spender.visitor ? VISITOR_KNOWLEDGE_CAP : GUEST_KNOWLEDGE_CAP;
}
// Server-wide enablement for destructive (delete/uninstall) tools — same flag as the
// headless MCP server. Default off: the assistant refuses them and tells the user how
// to enable, instead of offering a confirmation it cannot honour.
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
export type AgentRunContext = McpToolContext & {
  asPerson?: McpApiCaller;
  /**
   * The compact, audit-safe shape of this turn's Semantic Surface (spec Annex
   * A.4, item 5) — never the full snapshot. Named apart from `surface` on
   * purpose: that field already means `AgentSurface`, which door the call
   * came through, and is a different concept entirely.
   */
  semanticSurfaceRef?: ReturnType<typeof semanticSurfaceRef>;
  /**
   * The full, already-accepted (schema+semantics validated) Semantic Surface for
   * THIS turn — assistant-only, deliberately absent from `McpToolContext`, since
   * an external MCP protocol call has no "current turn" for a Surface to belong
   * to. Backs `read_surface`, the one tool that is not in `ALL_TOOLS`: it is
   * special-cased in `AssistantToolExecutionService.execOne`, not registered in
   * the shared registry, because its only data source is this field, which no
   * MCP-surface call could ever populate.
   */
  semanticSurface?: SurfaceSnapshot;
};

interface LoopState {
  endpoint: InferenceEndpoint;
  model: string;
  dto: AgentRequestDto;
  ctx: AgentRunContext;
  approved: Set<string>;
  conversation: ChatCompletionMessage[];
  steps: AgentToolStep[];
  firstSystem: ChatCompletionMessage[];
  leanSystem: ChatCompletionMessage[];
  tools: ChatTool[];
  executed: Map<string, string>;
  docLinks: DocLink[];
  emit?: AgentEmitter;
}

@Injectable()
export class AssistantAgentService {
  private readonly logger = new Logger(AssistantAgentService.name);

  constructor(
    private readonly inference: AssistantInferenceService,
    private readonly toolExecution: AssistantToolExecutionService,
    private readonly generation: AssistantGenerationService,
    private readonly guard: AssistantGuardService,
    private readonly knowledge: KnowledgeService,
    private readonly scopes: McpScopeResolver,
    private readonly audit: McpAuditRepository,
    private readonly catalog: CatalogService,
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
    return destructiveToolsAllowed((key) => this.config.get<string>(key));
  }

  async run(
    user: AuthenticatedUser,
    dto: AgentRequestDto,
    emit?: AgentEmitter,
    credential: ForwardedCredential = {},
    actor?: Actor,
  ): Promise<AgentResult> {
    // As early as reasonable (spec §11.1): a Surface that fails schema or
    // semantic validation is dropped silently right here, so nothing further
    // down this turn ever has to ask whether the one it is holding is real.
    const surface = acceptTurnSurface(dto.surface, dto.surfaceRevision);
    const { endpoint } = await this.inference.resolveEndpoint(dto, user);
    const model = await this.inference.resolveModel(dto, endpoint);
    // The same question the MCP surface asks before it builds a toolbox. Asked
    // here too because this is the other consumer of the same registry, and a
    // second path that filters differently is a second answer to give.
    const { isSandbox } = await this.policy.resolveAccess(
      principalFromUser(user),
    );
    const ctx = this.buildContext(user, credential, isSandbox, actor, surface);
    const approved = new Set(dto.approvedToolCallIds ?? []);
    const conversation: ChatCompletionMessage[] = dto.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
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
    const leanSystem = systemMessages(
      this.knowledge.basePrompt({ stable: AGENT_TOOL_NOTE }),
    );
    const cap = knowledgeCap(endpoint);

    // A resume (the tail holds the tool_calls the user just decided on) is already
    // past its KB-grounded decision: skip the router LLM call (already on-topic) and
    // run lean throughout. A fresh turn routes once and gets the full KB corpus for
    // its first decision only.
    // Not "the last message proposes tool calls" any more: a turn can now come
    // back having answered some of its own calls and none of the others — see
    // turn-transcript.util.ts.
    const resuming = unansweredToolCalls(conversation);
    const isResume = resuming.length > 0;
    // Appears exactly once per turn, on the first system-prompt build only —
    // never re-prepended on the lean rebuilds later iterations of the loop
    // use — matching vops's "after history, before the request" rule. A
    // missing surface leaves `firstSystem` byte-for-byte what it was before
    // this field existed (see the safety test).
    const surfaceBlock = renderSurfaceBlock(surface);
    let firstSystem = surfaceBlock
      ? systemMessages(
          this.knowledge.basePrompt({
            stable: AGENT_TOOL_NOTE,
            page: surfaceBlock,
          }),
        )
      : leanSystem;
    const tools = toolsForUser(ctx);
    if (cap) {
      await this.inference.assertGuestCanAffordTurn(
        endpoint,
        estimatePromptTokens([...firstSystem, ...conversation], tools) +
          Math.ceil(cap.maxChars / 4),
      );
    }
    // Doc links for the topics this turn is grounded in — surfaced on the final answer.
    // A resume already made its KB-grounded decision (no router call), so it carries none.
    let docLinks: DocLink[] = [];
    // A guest's resume is not taken on trust: whether a turn is a resume is
    // read off history the client wrote, and skipping the guard is what makes
    // the paid model answer anything.
    if (!isResume || isSandbox) {
      const turns = chatTurns(conversation);
      const route = await this.guard.route(
        endpoint,
        model,
        turns,
        this.knowledge.getIndexPrompt(),
      );
      if (route.offTopic) {
        await this.inference.noteOffTopic(endpoint);
        const content = await this.guard.refusal(endpoint, model, turns);
        conversation.push({ role: 'assistant', content });
        return { type: 'message', content, steps, messages: conversation };
      }
      const selection = this.knowledge.selectSections(
        route.sectionIds,
        lastUserText(turns),
      );
      const sectionIds = this.knowledge.capSections(selection.sectionIds, cap);
      this.logger.log(
        `Grounded via ${selection.via}: ${sectionIds.join(', ')}`,
      );
      docLinks = this.knowledge.docLinksFor(sectionIds);
      firstSystem = systemMessages(
        this.knowledge.systemPrompt(
          sectionIds,
          { stable: AGENT_TOOL_NOTE, page: surfaceBlock },
          cap,
        ),
      );
    }

    // Idempotency across the whole conversation: a write/destructive action already
    // performed (in a prior turn, e.g. the approved install) must never run again —
    // small models re-propose the same action and would install/delete twice.
    const executed = executedWriteKeys(conversation);
    if (isResume) {
      const before = steps.length;
      await this.toolExecution.resolveToolCalls(
        resuming,
        ctx,
        approved,
        conversation,
        steps,
        false,
        executed,
      );
      emitSteps(emit, steps, before);
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
      tools,
      executed,
      docLinks,
      emit,
    });
  }

  /**
   * The tool-use loop. Read/plan tools run transparently; write/destructive pend.
   * Identical read calls are memoized for the whole turn (small models re-issue the
   * same app_list/app_logs over and over — observed 7×): a repeat is skipped (no
   * re-run, no duplicate UI step), and an iteration that adds no new step means the
   * model is only looping → break to a final, tool-less synthesis.
   */
  private async runLoop(state: LoopState): Promise<AgentResult> {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const round = await this.iterate(state, i);
      if (round === 'looping') break;
      if (round !== 'progress') return round;
    }

    const room = await this.guestRoom(state);
    if (room !== 'loop') return this.closeTurn(state, room);
    // Force one final answer WITHOUT tools so the user gets a synthesis instead of a
    // dead-end (weaker models never stop calling tools on their own).
    const finalMsg = await this.generation.generate(
      state.endpoint,
      state.model,
      [...state.leanSystem, ...state.conversation],
      state.dto,
      undefined,
      state.emit,
    );
    if (finalMsg) state.conversation.push(finalMsg);
    return this.answer(state, finalMsg?.content ?? '');
  }

  private async iterate(
    state: LoopState,
    i: number,
  ): Promise<AgentResult | 'progress' | 'looping'> {
    if (i > 0) {
      const room = await this.guestRoom(state, state.tools);
      if (room !== 'loop') return this.closeTurn(state, room);
    }
    const system = i === 0 ? state.firstSystem : state.leanSystem;
    const msg = await this.generation.generate(
      state.endpoint,
      state.model,
      [...system, ...state.conversation],
      state.dto,
      state.tools,
      state.emit,
    );
    if (!msg) {
      return message(
        'No response from the inference endpoint.',
        state.steps,
        state.conversation,
      );
    }
    state.conversation.push(msg);
    if (!msg.tool_calls?.length) return this.answer(state, msg.content ?? '');
    return this.toolRound(state, msg.tool_calls);
  }

  private async answer(
    state: LoopState,
    content: string,
  ): Promise<AgentResult> {
    const safe = await this.generation.finalizeContent(
      content,
      state.conversation,
      state.steps,
      state.endpoint,
      state.model,
      state.dto,
      state.leanSystem,
      state.firstSystem,
    );
    return message(safe, state.steps, state.conversation, state.docLinks);
  }

  /**
   * Runs one round of tool calls. `looping` when every call was a cached
   * repeat: the model is going round in circles and should synthesize from
   * what it already has.
   */
  private async toolRound(
    state: LoopState,
    toolCalls: ToolCall[],
  ): Promise<AgentResult | 'progress' | 'looping'> {
    const { steps, conversation } = state;
    const stepsBefore = steps.length;
    const pending = await this.toolExecution.resolveToolCalls(
      toolCalls,
      state.ctx,
      state.approved,
      conversation,
      steps,
      true,
      state.executed,
    );
    emitSteps(state.emit, steps, stepsBefore);
    if (pending.length) {
      return {
        type: 'pending_action',
        pending,
        uiActions: collectUiActions(steps),
        steps,
        messages: conversation,
      };
    }
    return steps.length === stepsBefore ? 'looping' : 'progress';
  }

  /**
   * Whether a guest's turn may take another step: `loop` when what is left
   * covers the next call and a closing answer after it, `closing` when it
   * covers only a short answer without tools, `none` when not even that.
   */
  private async guestRoom(
    state: LoopState,
    tools?: ChatTool[],
  ): Promise<GuestRoom> {
    const remaining = await this.inference.guestRemaining(state.endpoint);
    if (remaining === null) return 'loop';
    const prompt = [...state.leanSystem, ...state.conversation];
    const closing = estimatePromptTokens(prompt) + CLOSING_MAX_TOKENS;
    const next =
      estimatePromptTokens(prompt, tools) +
      (outputTokenLimit(state.endpoint.spender, state.dto.maxTokens) ??
        DEFAULT_OUTPUT_TOKENS);
    if (remaining >= next + closing) return 'loop';
    return remaining >= closing ? 'closing' : 'none';
  }

  /** Ends a guest's turn on its budget with a short answer from what it gathered, when there is room for one. */
  private async closeTurn(
    state: LoopState,
    room: Exclude<GuestRoom, 'loop'>,
  ): Promise<AgentResult> {
    const { endpoint, model, dto, conversation, steps } = state;
    if (room === 'closing') {
      const note: ChatCompletionMessage = {
        role: 'user',
        content: endpoint.spender?.visitor
          ? CLOSING_NOTE.visitor
          : CLOSING_NOTE.guest,
      };
      const closing = await this.generation
        .generate(
          endpoint,
          model,
          [...state.leanSystem, ...conversation, note],
          dto,
          undefined,
          state.emit,
          CLOSING_MAX_TOKENS,
        )
        .catch(() => null);
      if (closing?.content) {
        conversation.push(closing);
        const safe = await this.generation.finalizeContent(
          closing.content,
          conversation,
          steps,
          endpoint,
          model,
          dto,
          state.leanSystem,
          state.firstSystem,
        );
        return message(safe, steps, conversation, state.docLinks);
      }
    }
    return this.budgetStop(state);
  }

  private budgetStop(state: LoopState): AgentResult {
    const content = guestBudgetMessage(state.endpoint.spender?.visitor);
    state.conversation.push({ role: 'assistant', content });
    return message(content, state.steps, state.conversation, state.docLinks);
  }

  private buildContext(
    user: AuthenticatedUser,
    credential: ForwardedCredential,
    isSandbox: boolean,
    driver?: Actor,
    surface?: SurfaceSnapshot,
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
      // Every destructive op still waits for the per-action confirmation;
      // MCP_ALLOW_DESTRUCTIVE=false withholds them altogether.
      allowDestructive: this.destructiveEnabled(),
      surface: 'assistant',
      audit: this.audit,
      semanticSurfaceRef: semanticSurfaceRef(surface),
      semanticSurface: surface,
    };
  }
}
