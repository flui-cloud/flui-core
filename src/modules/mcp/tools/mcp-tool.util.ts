import { z, ZodRawShape } from 'zod';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CatalogService } from '../../catalog/services/catalog.service';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { AppManagementService } from '../../applications/services/app-management.service';
import { ScheduledJobsService } from '../../applications/services/scheduled-jobs.service';
import { ApplicationReleaseService } from '../../applications/services/application-release.service';
import { ApplicationSourceDeployService } from '../../applications/services/application-source-deploy.service';
import { TemplatesService } from '../../templates/templates.service';
import { RepositoriesService } from '../../repositories/services/repositories.service';
import { GitHubOAuthService } from '../../repositories/services/github-oauth.service';
import { GithubAppUserAuthService } from '../../repositories/services/github-app-user-auth.service';
import { GithubAppManifestStateService } from '../../repositories/services/github-app-manifest-state.service';
import { LokiQueryService } from '../../observability/services/loki-query.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { InfrastructureOperationsService } from '../../infrastructure/operations/infrastructure-operations.service';
import { PodDebugService } from '../../scaling/services/pod-debug.service';
import { BackupPoliciesService } from '../../backups/services/backup-policies.service';
import { BackupJobsService } from '../../backups/services/backup-jobs.service';
import { BackupStatusService } from '../../backups/services/backup-status.service';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { FullMigrationService } from '../../full-migration/services/full-migration.service';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { McpScope, SCOPE_TIER } from '../constants/mcp-scopes';
import { describeError } from '../../shared/utils/error.util';

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
  scheduledJobs: ScheduledJobsService;
  releases: ApplicationReleaseService;
  templates: TemplatesService;
  repos: RepositoriesService;
  github: GitHubOAuthService;
  githubAuth: GithubAppUserAuthService;
  githubManifest: GithubAppManifestStateService;
  loki: LokiQueryService;
  clusters: ClustersService;
  operations: InfrastructureOperationsService;
  podDebug: PodDebugService;
  backupPolicies: BackupPoliciesService;
  backupJobs: BackupJobsService;
  backupStatus: BackupStatusService;
  appMigration: AppMigrationService;
  dbMigration: DbMigrationService;
  fullMigration: FullMigrationService;
}

/** Per-request context shared by every tool registrar. */
export interface McpToolContext {
  user: AuthenticatedUser;
  scopes: Set<string>;
  allowDestructive: boolean;
  audit: McpAuditRepository;
  services: McpServices;
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

function outcomeNote(status: string, done: boolean): string {
  if (status === 'FAILED' || status === 'CANCELLED') {
    return 'The operation FAILED. Tell the user the exact reason in `error` and what to do about it; do NOT retry the same action until that cause is resolved.';
  }
  if (done) {
    return 'The operation completed successfully.';
  }
  return 'Started — it runs in the background and the user is shown a live progress widget for it, so you do NOT need to wait, re-check, or report completion. Just say it has started; never claim it finished and never promise to notify them.';
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
    note: outcomeNote(op.status, done),
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
    const message = describeError(error);
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
