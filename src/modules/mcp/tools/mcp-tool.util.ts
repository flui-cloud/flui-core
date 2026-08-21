import { z, ZodRawShape } from 'zod';
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
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { McpScope, SCOPE_TIER } from '../constants/mcp-scopes';
import type { ServerContext } from '@modelcontextprotocol/server';
import {
  InputRequiredResult,
  McpRequestRound,
  isInputRequired,
  readRound,
} from '../protocol/mrtr';
import { describeError } from '../../shared/utils/error.util';
import { McpApiCaller, McpApiError } from '../services/mcp-api.client';

/** A tool result in MCP's content shape. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** The existing Nest services the thin tools delegate to (no new business logic). */
export interface McpServices {
  catalog: CatalogService;
  installer: CatalogInstallerService;
  apps: ApplicationService;
  deploy: ApplicationDeployService;
  sourceDeploy: ApplicationSourceDeployService;
  management: AppManagementService;
  appConfig: AppConfigService;
  scheduledJobs: ScheduledJobsService;
  gateway: GatewayService;
  releases: ApplicationReleaseService;
  templates: TemplatesService;
  repos: RepositoriesService;
  github: GitHubOAuthService;
  githubAuth: GithubAppUserAuthService;
  githubManifest: GithubAppManifestStateService;
  loki: LokiQueryService;
  traffic: ApplicationTrafficService;
  alertEvents: AlertEventsService;
  clusters: ClustersService;
  clusterDnsZone: ClusterDnsZoneService;
  operations: InfrastructureOperationsService;
  podDebug: PodDebugService;
  backupPolicies: BackupPoliciesService;
  backupJobs: BackupJobsService;
  backupStatus: BackupStatusService;
  appMigration: AppMigrationService;
  dbMigration: DbMigrationService;
  fullMigration: FullMigrationService;
  mailReadiness: MailReadinessService;
  mailSend: MailSendService;
  mailSuppressions: MailSuppressionService;
}

/**
 * Which consumer is running the tool. The two differ in what the caller can see:
 * the Flui UI renders a progress widget for async operations, an external MCP
 * client renders nothing. Guidance addressed to the model has to know which.
 */
export type ToolSurface = 'mcp' | 'assistant';

/** Per-request context shared by every tool registrar. */
export interface McpToolContext {
  user: AuthenticatedUser;
  scopes: Set<string>;
  allowDestructive: boolean;
  audit: McpAuditRepository;
  services: McpServices;
  /**
   * The Flui API, called over HTTP as the caller's own principal.
   *
   * A converted tool uses this and NOT `services`: the guards are decorations on
   * the controllers, so a service call reached in process walks past every one
   * of them while a real request cannot. The caller is already bound to the
   * credential the inbound request carried — no tool body ever sees a token, and
   * none is minted.
   *
   * Conversion is per tool, so both fields are populated while the catalog
   * is still mixed.
   */
  api: McpApiCaller;
  surface: ToolSurface;
  /**
   * What the current round of a multi-round-trip call carried (MCP 2026-07-28).
   * Named after the SDK's own `ctx.mcpReq`, and now filled from it: the package
   * lifts `inputResponses`/`requestState` off the wire and hands them to the
   * handler. Absent on a first call, and on the assistant surface, which has no
   * MCP request at all.
   */
  mcpReq?: McpRequestRound;
}

/**
 * One tool, defined once. The MCP server (external agents) and the Flui Assistant
 * agent loop (in-process) both consume this — name, schema, required scope and the
 * raw business call. Gating/audit lives in the consumer, not the definition.
 */
export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  scope: McpScope;
  run: (
    args: z.infer<z.ZodObject<Shape>>,
    ctx: McpToolContext,
  ) => Promise<unknown>;
  /**
   * Optional compact projection fed to the LLM in the agent loop, when the full
   * result is bulky/deterministic (e.g. logs, long lists). The full result still
   * reaches the UI; only the model sees this slimmed view, to spare the context.
   */
  forModel?: (data: unknown) => unknown;
}

/** Identity helper that preserves each tool's argument types at the call site. */
export function defineTool<Shape extends ZodRawShape>(
  def: ToolDef<Shape>,
): ToolDef<Shape> {
  return def;
}

/**
 * The validating form of a tool's input contract, strict on purpose.
 *
 * A permissive object DROPS unknown keys instead of rejecting them, which is the
 * worst possible failure for a model-driven caller: a plausible-but-wrong argument
 * name leaves the real parameter `undefined`, the tool runs unfiltered, and the
 * agent is handed a confident, successful answer to a question it never asked. An
 * explicit rejection costs one turn; a silent one poisons the whole chain.
 */
export function toolInputSchema<Shape extends ZodRawShape>(shape: Shape) {
  const keys = Object.keys(shape);
  const accepted = keys.length ? keys.join(', ') : '(none)';
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      return `Unknown argument(s): ${issue.keys.join(', ')}. Accepted argument(s): ${accepted}.`;
    },
  });
}

// LLM tool-calling often encodes every argument as a string ("true", "200").
// These coerce such values back before validation, keeping the inner constraints.
function asBoolean(v: unknown): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

export const coerceBoolean = () => z.preprocess(asBoolean, z.boolean());

export const coerceNumber = (inner: z.ZodNumber) =>
  z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
        ? Number(v)
        : v,
    inner,
  );

/**
 * Resolve the cluster a cluster-scoped tool should act on. An explicit id wins;
 * otherwise, if exactly one cluster exists, it is used automatically (so the model
 * doesn't need a cluster_list round-trip). With zero or several clusters it throws a
 * message the model can act on — the error surfaces as the tool result.
 */
export async function resolveClusterId(
  ctx: McpToolContext,
  clusterId?: string,
): Promise<string> {
  if (clusterId) return clusterId;
  const clusters = await ctx.services.clusters.listClusters();
  if (clusters.length === 1) return clusters[0].id;
  if (clusters.length === 0) {
    throw new Error('No clusters exist yet — create one before querying it.');
  }
  const choices = clusters.map((c) => `${c.name} (${c.id})`).join(', ');
  throw new Error(
    `Several clusters exist — pass clusterId. Available: ${choices}.`,
  );
}

export interface OperationOutcome {
  operationId: string;
  status: string;
  done: boolean;
  error?: string;
  /** Plain-language guidance the model can relay; surface-agnostic (MCP + assistant). */
  note: string;
  /** Human-readable summary, e.g. "Install MariaDB" — the UI shows this on the progress widget. */
  label?: string;
}

function outcomeNote(
  status: string,
  done: boolean,
  surface: ToolSurface,
): string {
  if (status === 'FAILED' || status === 'CANCELLED') {
    return 'The operation FAILED. Tell the user the exact reason in `error` and what to do about it; do NOT retry the same action until that cause is resolved.';
  }
  if (done) {
    return 'The operation completed successfully.';
  }
  // Only the Flui UI polls the operation to a progress widget. Telling an external
  // MCP client the same thing strands the operation: nobody watches it, and a
  // failure 30s later is never surfaced to anyone.
  if (surface === 'assistant') {
    return 'Started — it runs in the background and the user is shown a live progress widget for it, so you do NOT need to wait, re-check, or report completion. Just say it has started; never claim it finished and never promise to notify them.';
  }
  return 'Started in the background. Nothing polls it for you on this surface, so YOU must follow it: call operation_status with this operationId until `done` is true, then report the real outcome. Never claim it finished before `done`.';
}

/**
 * Read a just-started async operation ONCE and return its handle immediately — no
 * waiting. The UI renders a non-blocking progress widget that polls the operation to
 * completion, so the tool returns instantly and the model never blocks or fakes a
 * "I'll let you know" promise. Synchronous preflight failures never reach here (they
 * throw before an operation exists and surface as an inline error).
 */
export async function readOperationOutcome(
  ctx: McpToolContext,
  operationId: string,
  label?: string,
): Promise<OperationOutcome> {
  const op = await ctx.services.operations.getOperationDetails(operationId);
  const done =
    op.status === 'COMPLETED' ||
    op.status === 'FAILED' ||
    op.status === 'CANCELLED';
  return {
    operationId,
    status: op.status,
    done,
    error: op.errorMessage,
    note: outcomeNote(op.status, done, ctx.surface),
    label,
  };
}

/**
 * Remove an installed application by id, routing server-side so the model never has
 * to know how it was created: an app that belongs to a catalog install is removed as
 * the WHOLE install (all components); a custom/source app is deleted on its own.
 * Either removal tool funnels here, so whichever the model picks does the right thing.
 */
export async function removeApplication(
  ctx: McpToolContext,
  applicationId: string,
): Promise<OperationOutcome & { removed: 'catalog-install' | 'application' }> {
  const app = await ctx.services.apps.findById(applicationId);
  const install = await ctx.services.installer.findInstallByApplicationId(
    applicationId,
    app.clusterId,
  );
  if (install) {
    // Every component of a multi-component install maps to the SAME install, so a
    // removal that is already underway/done must not be re-triggered — the model
    // tends to call remove once per listed component.
    if (
      install.status === CatalogInstallStatus.UNINSTALLING ||
      install.status === CatalogInstallStatus.UNINSTALLED
    ) {
      const done = install.status === CatalogInstallStatus.UNINSTALLED;
      return {
        removed: 'catalog-install',
        operationId: install.operationId ?? '',
        status: done ? 'COMPLETED' : 'IN_PROGRESS',
        done,
        note: done
          ? 'This app and all its components were already removed.'
          : 'This app is already being removed — all its components go together, so there is nothing more to remove. Do not call remove again for its other components.',
      };
    }
    const { operation } = await ctx.services.installer.uninstall(
      install.id,
      ctx.user.userId,
    );
    const outcome = await readOperationOutcome(
      ctx,
      operation.id,
      `Uninstall ${install.displayName}`,
    );
    return { removed: 'catalog-install', ...outcome };
  }
  const operation = (await ctx.services.deploy.deleteApplication(
    applicationId,
    ctx.user.userId,
  )) as { id: string };
  const outcome = await readOperationOutcome(
    ctx,
    operation.id,
    `Delete ${app.name}`,
  );
  return { removed: 'application', ...outcome };
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Whether this principal could actually run the tool, were it to call it now. Both
 * conditions are fixed for the life of a request, so a `false` here means "never",
 * not "not yet" — which is what makes it safe to hide the tool rather than offer it.
 */
export function isExecutable(ctx: McpToolContext, def: ToolDef): boolean {
  if (!ctx.scopes.has(def.scope)) return false;
  return SCOPE_TIER[def.scope] !== 'destructive' || ctx.allowDestructive;
}

/**
 * The whole MCP-side execution of one tool: gate, run, project. `forModel` matters
 * more here than in the assistant loop — an MCP client has no UI to receive the full
 * DTO, so the model is the only consumer and the compact view is the right payload.
 */
export function runTool(
  ctx: McpToolContext,
  def: ToolDef,
  args: unknown,
  sdkCtx?: ServerContext,
): Promise<ToolResult | InputRequiredResult> {
  // The round is read per call, not per connection: a retry carrying
  // inputResponses is a different round of the same conversation, and nothing
  // about the principal or its scopes changes with it.
  const scoped: McpToolContext = {
    ...ctx,
    mcpReq: readRound(sdkCtx?.mcpReq),
  };
  return runGated(scoped, def.name, def.scope, async () => {
    const data = await def.run(args as never, scoped);
    return def.forModel && !isInputRequired(data) ? def.forModel(data) : data;
  });
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
): Promise<ToolResult | InputRequiredResult> {
  if (!ctx.scopes.has(scope)) {
    await ctx.audit.record({
      userId: ctx.user.userId,
      tool,
      scope,
      allowed: false,
      error: 'missing scope',
    });
    // Named as a GRANT problem, because the other refusal an agent meets on
    // this surface — the one the API's own guards raise — is a PERMISSION
    // problem, and an agent that cannot tell them apart tells the user the
    // wrong thing. This one means "the tool was never handed to you"; the other
    // means "you hold the tool but not this resource".
    return errorResult(
      `Refused: missing required scope '${scope}'. This is a GRANT problem, not an access-control one: the agent credential in use does not carry that scope, so no resource will make this call work. Ask for the scope to be granted; do not retry meanwhile.`,
    );
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
    // An input-required return is handed back untouched, which is the whole
    // point of the migration: the 2026-07-28 codec renders it — `resultType`,
    // the embedded requests, the server identity in `_meta` — and `isError`
    // never appears, because waiting for a person is a state and an agent that
    // reads a failure retries. On a 2025-era request the SDK's own legacy shim
    // takes it from here; neither path is ours to re-render.
    return isInputRequired(data) ? data : jsonResult(data);
  } catch (error) {
    // A refusal that came back from the API is not a generic failure and must
    // not read like one. `describeError` would flatten it to "[403] Not allowed
    // to app:read on application 'x'", which loses the two things the agent
    // acts on: that this is the guard and not the scope, and that retrying is
    // pointless. `agentMessage` carries both.
    const message =
      error instanceof McpApiError ? error.agentMessage : describeError(error);
    await ctx.audit.record({
      userId: ctx.user.userId,
      tool,
      scope,
      // An access refusal from a guard is not "the tool ran": the scope let it
      // through, the resource did not. Recorded as denied so the audit tells
      // the two refusals apart the same way the agent does.
      allowed: !(error instanceof McpApiError && error.isAccessRefusal),
      error: message,
    });
    return errorResult(message);
  }
}
