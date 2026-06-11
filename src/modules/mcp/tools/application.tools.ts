import { z } from 'zod';
import { DeployApplicationDto } from '../../applications/dto/deploy-application.dto';
import { DeployFromYamlDto } from '../../applications/dto/deploy-from-yaml.dto';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { AppEventType } from '../../applications/enums/app-event-type.enum';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  coerceBoolean,
  coerceNumber,
  defineTool,
  removeApplication,
  resolveClusterId,
  ToolDef,
} from './mcp-tool.util';

// Explicit sentinel so a weak model reads "no endpoint" rather than guessing one
// exists (or deflecting to the CLI) when the url/internalUrl fields are simply absent.
const NO_ENDPOINT = 'none — app has no endpoint configured';

/** Operations carry config sub-objects; the model only needs the handle + status. */
function operationView(data: unknown): unknown {
  const op = data as { id?: string; operationType?: string; status?: string };
  return { operationId: op.id, type: op.operationType, status: op.status };
}

/**
 * Validate a model-supplied enum filter case-insensitively. Returns undefined when
 * the value is absent. On a value that is not part of the enum, throws a message that
 * names the allowed values — so the model self-corrects instead of hitting a cryptic
 * Postgres enum error (e.g. the model passing category="database" when DATABASE is a kind).
 */
function matchEnum<T extends Record<string, string>>(
  field: string,
  value: string | undefined,
  enumObj: T,
  casing: 'upper' | 'lower',
): T[keyof T] | undefined {
  if (value === undefined) return undefined;
  const wanted = casing === 'upper' ? value.toUpperCase() : value.toLowerCase();
  const allowed = Object.values(enumObj);
  const hit = allowed.find((v) => v === wanted);
  if (!hit) {
    throw new Error(
      `Invalid ${field} "${value}". Allowed ${field} values: ${allowed.join(', ')}.`,
    );
  }
  return hit as T[keyof T];
}

/** Container state → a one-line problem string (or none when it is healthy). */
function containerProblem(state?: {
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode?: number; message?: string };
}): string | undefined {
  const w = state?.waiting;
  if (w?.reason) return w.message ? `${w.reason}: ${w.message}` : w.reason;
  const t = state?.terminated;
  if (t?.reason) {
    const base = `${t.reason} (exit ${t.exitCode})`;
    return t.message ? `${base}: ${t.message}` : base;
  }
  return undefined;
}

/**
 * Pod-debug dumps are huge (env, annotations, probes, affinity); the model only
 * needs the failure signal: phase, each container's readiness/restarts/problem,
 * missing mounts, and the most recent events.
 */
function podDebugView(data: unknown): unknown {
  const pods = data as Array<{
    name?: string;
    phase?: string;
    containers?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: Parameters<typeof containerProblem>[0];
    }>;
    volumes?: Array<{ name?: string; exists?: boolean }>;
    events?: Array<{
      type?: string;
      reason?: string;
      message?: string;
      count?: number;
    }>;
  }>;
  return pods.map((p) => ({
    pod: p.name,
    phase: p.phase,
    containers: (p.containers ?? []).map((c) => ({
      name: c.name,
      ready: c.ready,
      restarts: c.restartCount,
      problem: containerProblem(c.state),
    })),
    missingMounts: (p.volumes ?? [])
      .filter((v) => v.exists === false)
      .map((v) => v.name),
    events: (p.events ?? []).slice(0, 6).map((e) => ({
      type: e.type,
      reason: e.reason,
      message: e.message,
      count: e.count,
    })),
  }));
}

/** Runtime responses carry pods/containers; the model only needs the replica summary. */
function runtimeView(data: unknown): unknown {
  const r = data as {
    deploymentName?: string;
    replicas?: { desired?: number; ready?: number; available?: number };
  };
  return {
    app: r.deploymentName,
    desired: r.replicas?.desired,
    ready: r.replicas?.ready,
    available: r.replicas?.available,
  };
}

/** Application read tools, plus gated deploy (write) and delete (destructive). */
export const APPLICATION_TOOLS: ToolDef[] = [
  defineTool({
    name: 'operation_status',
    description:
      'Check the outcome of an async operation by its operationId (returned by install/uninstall/deploy/scale). Use this to confirm whether the work actually succeeded or failed before telling the user — these operations run in the background and the initial call only enqueues them. On failure the result carries the real error message and the corrective action.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { operationId: z.string() },
    run: async (args, ctx) =>
      ctx.services.operations.getOperationDetails(args.operationId),
    forModel: (data) => {
      const op = data as {
        id?: string;
        operationType?: string;
        status?: string;
        progress?: number;
        currentStepIndex?: number;
        totalSteps?: number;
        errorMessage?: string;
      };
      const terminal = op.status === 'COMPLETED' || op.status === 'FAILED';
      let note: string | undefined;
      if (op.status === 'FAILED') {
        note =
          'The operation failed for the reason in `error`. Tell the user that exact cause and what to do about it; do NOT retry the same action until the cause is resolved.';
      } else if (op.status !== 'COMPLETED') {
        note =
          'Still running — it is not finished yet. Tell the user it is provisioning and that they can ask you to check again; never claim it completed, and do not promise to notify them automatically.';
      }
      return {
        operationId: op.id,
        type: op.operationType,
        status: op.status,
        done: terminal,
        progress: op.progress,
        step:
          op.totalSteps != null
            ? `${op.currentStepIndex ?? 0}/${op.totalSteps}`
            : undefined,
        error: op.errorMessage,
        note,
      };
    },
  }),
  defineTool({
    name: 'app_list',
    description:
      'List deployed applications on a cluster. clusterId is optional: if omitted and there is a single cluster, it is used automatically — only call cluster_list first when several clusters exist. Optional filters: category (system | user), kind (DATABASE | APPLICATION | TOOL | SYSTEM), status (lowercase: running, degraded, failed, ...). To find DATABASES use kind=DATABASE — "database" is a kind, NOT a category. Omit a filter to list everything.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      clusterId: z.string().optional(),
      category: z.string().optional(),
      kind: z.string().optional(),
      status: z.string().optional(),
    },
    run: async (args, ctx) => {
      const clusterId = await resolveClusterId(ctx, args.clusterId);
      const category = matchEnum(
        'category',
        args.category,
        ApplicationCategory,
        'lower',
      );
      const kind = matchEnum('kind', args.kind, ApplicationKind, 'upper');
      const status = matchEnum(
        'status',
        args.status,
        ApplicationStatus,
        'lower',
      );
      const apps = await ctx.services.apps.findByClusterId(clusterId, {
        category,
        kind,
        status,
      });
      return ctx.services.apps.toResponseDtosWithUrls(apps);
    },
    // The model only needs identity + status + the real link; the UI gets full DTOs.
    forModel: (data) => {
      const apps = data as Array<{
        id?: string;
        name?: string;
        status?: string;
        kind?: string;
        url?: string;
        internalUrl?: string;
      }>;
      return apps.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        kind: a.kind,
        url: a.url ?? a.internalUrl ?? NO_ENDPOINT,
      }));
    },
  }),
  defineTool({
    name: 'app_get',
    description:
      'Get one application by id: status, config, image, replicas, access URL, and any in-flight deploy/rollback operation.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: async (args, ctx) => {
      const app = await ctx.services.apps.findById(args.id);
      return ctx.services.apps.toResponseDtoWithOperation(app);
    },
    // The full DTO (env, resources, metadata, revisions) is large; the model needs
    // identity, health, the real access link, and any in-flight operation.
    forModel: (data) => {
      const d = data as {
        id?: string;
        name?: string;
        slug?: string;
        status?: string;
        kind?: string;
        exposure?: string;
        imageRef?: string;
        replicas?: number;
        url?: string;
        internalUrl?: string;
        lastOperation?: { operationType?: string; status?: string };
      };
      return {
        id: d.id,
        name: d.name,
        slug: d.slug,
        status: d.status,
        kind: d.kind,
        exposure: d.exposure,
        imageRef: d.imageRef,
        replicas: d.replicas,
        url: d.url ?? d.internalUrl ?? NO_ENDPOINT,
        lastOperation: d.lastOperation
          ? {
              type: d.lastOperation.operationType,
              status: d.lastOperation.status,
            }
          : undefined,
      };
    },
  }),
  defineTool({
    name: 'app_status',
    description:
      'Live runtime status of an application: replica counts (desired/ready/available), containers and rollout state — the current health, not the stored config.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.services.management.getRuntimeStatus(args.id),
    forModel: runtimeView,
  }),
  defineTool({
    name: 'app_debug',
    description:
      "Diagnose WHY an application is failing, crashing or stuck — use this when app_status shows pods not ready or app_logs returns nothing (a pod that never started has no logs). Returns each pod's phase, per-container readiness/restart count and the exact failure reason (CrashLoopBackOff, ImagePullBackOff, OOMKilled, exit codes), any missing mounted Secrets/ConfigMaps, and the most recent Kubernetes events. For a failed CATALOG install (which is multi-component), call app_list to find its component apps, then app_debug the one that is not running. id is a single application id.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.services.podDebug.getPodsDebugInfo(args.id),
    forModel: podDebugView,
  }),
  defineTool({
    name: 'app_releases',
    description:
      'List the deploy/rollback release history of an application, most recent first.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      id: z.string(),
      limit: coerceNumber(z.number().int().positive().max(100)).optional(),
    },
    run: (args, ctx) => ctx.services.releases.listReleases(args.id, args.limit),
  }),
  defineTool({
    name: 'app_events',
    description:
      'List audit/history events for an application (deploy, rollback, scale, ...), most recent first.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      id: z.string(),
      eventType: z.string().optional(),
      limit: coerceNumber(z.number().int().positive().max(200)).optional(),
      offset: coerceNumber(z.number().int().nonnegative()).optional(),
    },
    run: async (args, ctx) => {
      const result = await ctx.services.apps.getAuditEvents(args.id, {
        eventType: args.eventType as AppEventType | undefined,
        limit: args.limit,
        offset: args.offset,
      });
      return {
        total: result.total,
        events: result.events.map((e) =>
          ctx.services.apps.toAuditEventSummaryDto(e),
        ),
      };
    },
  }),
  defineTool({
    name: 'app_deploy_from_yaml',
    description:
      'Deploy a CUSTOM application from a flui.yaml manifest (kind: Application) you compose for the user. Validate it first with spec_validate. A real deploy requires a connected GitHub repository (repoFullName as owner/repo) — Flui builds it via GitHub Actions; set validateOnly:true to check the manifest without deploying or needing a repo. clusterId is optional (the sole cluster is used).',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      yaml: z.string(),
      repoFullName: z.string().optional(),
      clusterId: z.string().optional(),
      branch: z.string().optional(),
      validateOnly: z.boolean().optional(),
    },
    run: async (args, ctx) => {
      const dto: DeployFromYamlDto = {
        yaml: args.yaml,
        clusterId: await resolveClusterId(ctx, args.clusterId),
        repoFullName: args.repoFullName ?? '',
        branch: args.branch,
        validateOnly: args.validateOnly,
      };
      return ctx.services.sourceDeploy.deployFromYaml(ctx.user.userId, dto);
    },
  }),
  defineTool({
    name: 'app_deploy',
    description:
      'Trigger a deploy of an existing application. Provide a specific image/commit/build, or set useCurrentImage to redeploy the current one.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      imageRef: z.string().optional(),
      commitSha: z.string().optional(),
      buildId: z.string().optional(),
      useCurrentImage: coerceBoolean().optional(),
      reason: z.string().optional(),
    },
    run: (args, ctx) => {
      const dto: DeployApplicationDto = {
        imageRef: args.imageRef,
        commitSha: args.commitSha,
        buildId: args.buildId,
        useCurrentImage: args.useCurrentImage,
        reason: args.reason,
      };
      return ctx.services.deploy.deploy(args.id, dto, ctx.user.userId);
    },
    forModel: operationView,
  }),
  defineTool({
    name: 'app_scale',
    description:
      'Set the number of running replicas for an application (0–20). Use 0 to stop it, or a higher number to scale out.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      replicas: z.number().int().min(0).max(20),
    },
    run: (args, ctx) =>
      ctx.services.management.updateReplicas(args.id, {
        replicas: args.replicas,
      }),
    forModel: runtimeView,
  }),
  defineTool({
    name: 'app_restart',
    description:
      'Trigger a rolling restart of an application (recreates its pods without changing the image or config).',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.services.management.restartDeployment(args.id),
    forModel: runtimeView,
  }),
  defineTool({
    name: 'app_stop',
    description:
      'Stop an application (scale it to 0 replicas). It stays deployed and can be started again later.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.services.management.stop(args.id),
    forModel: runtimeView,
  }),
  defineTool({
    name: 'app_start',
    description:
      'Start a previously stopped application (restore its replicas and mark it running).',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.services.management.start(args.id),
    forModel: runtimeView,
  }),
  defineTool({
    name: 'app_delete',
    description:
      'Remove an INSTALLED application by its id and clean up its resources. Find the id with app_list first — the catalog only lists installable definitions, not what is installed. Works for both catalog-installed apps (removes the entire multi-component install) and custom apps; you do NOT need to know which it is. Returns an async operation — confirm via operation_status. Destructive.',
    scope: MCP_SCOPE.APP_DESTRUCTIVE,
    inputSchema: { id: z.string() },
    run: (args, ctx) => removeApplication(ctx, args.id),
  }),
];
