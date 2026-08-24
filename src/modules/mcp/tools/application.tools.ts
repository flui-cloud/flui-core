import { z } from 'zod';
import { DeployApplicationDto } from '../../applications/dto/deploy-application.dto';
import { DeployFromYamlDto } from '../../applications/dto/deploy-from-yaml.dto';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  enc,
  matchEnum,
  operationView,
  podDebugView,
  replicaStateView,
  runtimeView,
  urlForModel,
} from './application-views.util';
import {
  coerceBoolean,
  coerceNumber,
  defineTool,
  removeApplication,
  resolveClusterId,
  ToolDef,
} from './mcp-tool.util';

/**
 * What a removal preview should read like to a model that is about to suggest a
 * removal: the sentence first, and an explicit "unknown" rather than a silent
 * empty list when the cluster could not be reached.
 */
function removalPreviewView(raw: unknown): unknown {
  const p = raw as {
    removes?: string;
    label?: string;
    applications?: { name?: string }[];
    volumes?: { name?: string; namespace?: string; sizeLabel?: string }[];
    totalLabel?: string;
    volumesKnown?: boolean;
    dataWarning?: string | null;
    note?: string;
  };
  return {
    removes: p.removes,
    label: p.label,
    components: (p.applications ?? []).map((a) => a.name),
    storage: p.volumesKnown
      ? {
          total: p.totalLabel,
          volumes: (p.volumes ?? []).map(
            (v) => `${v.namespace}/${v.name} (${v.sizeLabel})`,
          ),
        }
      : 'unknown — the cluster could not be read, so do NOT tell the person no data will be lost',
    dataWarning:
      p.dataWarning ??
      (p.volumesKnown
        ? 'This removal takes no persistent volume with it.'
        : null),
    note: p.note,
  };
}

/** Application read tools, plus gated deploy (write) and delete (destructive). */
export const APPLICATION_TOOLS: ToolDef[] = [
  defineTool({
    name: 'operation_status',
    routes: [
      'GET /infrastructure/operations/:id',
      'GET /applications/:id/operations',
    ],
    description:
      "Check the outcome of an async operation by its operationId (returned by install/uninstall/deploy/scale). Use this to confirm whether the work actually succeeded or failed before telling the user — these operations run in the background and the initial call only enqueues them. On failure the result carries the real error message and the corrective action. ALWAYS pass applicationId when the operation belongs to an application (the tool that started it hands it back): that is the reading route a non-administrator is allowed on. Without it the lookup falls back to the infrastructure route, which only an administrator, the operation's owner, or whoever runs the instance may read.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      operationId: z.string(),
      applicationId: z.string().optional(),
    },
    // Two routes, and which one is used is not a detail: `GET
    // /applications/:id/operations` sits behind `AppAccessGuard`, so an operator
    // reads the operations of an application that is theirs; `GET
    // /infrastructure/operations/:id` sits behind the infrastructure section
    // and asks whose the operation is, which serves an administrator, an
    // operator, and a sandbox guest following their own install.
    // Neither route is widened here — the tool picks the one the caller can
    // actually pass.
    run: async (args, ctx) => {
      if (!args.applicationId) {
        return ctx.api.get(
          `/infrastructure/operations/${enc(args.operationId)}`,
        );
      }
      const page = await ctx.api.get<{
        items: Array<{ id?: string }>;
      }>(`/applications/${enc(args.applicationId)}/operations`, { limit: 100 });
      const op = page.items?.find((o) => o.id === args.operationId);
      if (!op) {
        throw new Error(
          `Operation ${args.operationId} is not among the recent operations of application ${args.applicationId}. Check the applicationId, or call this again without it if the operation is an infrastructure one.`,
        );
      }
      return op;
    },
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
    routes: ['GET /clusters/:clusterId/applications'],
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
      // The route filters to what the caller may read and carries the address
      // enrichment this tool used to apply itself. The enum matching above stays
      // here to hand the model a message it can correct from, which a 400 is not.
      return ctx.api.get(`/clusters/${enc(clusterId)}/applications`, {
        category,
        kind,
        status,
      });
    },
    // The model only needs identity + status + the real link; the UI gets full DTOs.
    forModel: (data) => {
      const apps = data as Array<{
        id?: string;
        name?: string;
        slug?: string;
        status?: string;
        kind?: string;
        url?: string;
        internalUrl?: string;
        endpointStatus?: string;
        endpointError?: string;
      }>;
      return apps.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        status: a.status,
        kind: a.kind,
        url: urlForModel(a),
      }));
    },
  }),
  defineTool({
    name: 'app_get',
    routes: ['GET /applications/:id'],
    description:
      'Get one application by id: status, config, image, replicas, access URL, and any in-flight deploy/rollback operation.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    // Over the wire: `GET /applications/:id` carries
    // `AppAccessGuard`, so naming another tenancy's application here is refused
    // by the guard before the handler loads a row — which the in-process
    // `apps.findById` could never do, since no guard sits on a service call.
    run: (args, ctx) => ctx.api.get(`/applications/${enc(args.id)}`),
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
        url: urlForModel(d),
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
    routes: ['GET /applications/:id/runtime'],
    description:
      'Live runtime status of an application: replica counts (desired/ready/available), containers and rollout state — the current health, not the stored config.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.api.get(`/applications/${enc(args.id)}/runtime`),
    forModel: runtimeView,
  }),
  defineTool({
    name: 'app_debug',
    routes: ['GET /applications/:id/debug/pods'],
    description:
      "Diagnose WHY an application is failing, crashing or stuck — use this when app_status shows pods not ready or app_logs returns nothing (a pod that never started has no logs). Returns each pod's phase, per-container readiness/restart count and the exact failure reason (CrashLoopBackOff, ImagePullBackOff, OOMKilled, exit codes), any missing mounted Secrets/ConfigMaps, and the most recent Kubernetes events. For a failed CATALOG install (which is multi-component), call app_list to find its component apps, then app_debug the one that is not running. id is a single application id.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    // `GET /applications/:applicationId/debug/pods`. Note what the wire does
    // NOT add: PodDebugController names its parameter `:applicationId`, which
    // `AppAccessGuard` does not read, and mounts no per-application guard — so
    // this route is as open as it was and the conversion inherits exactly that.
    // Going over the wire makes the API's protection reach the agent; it never
    // invents protection the API does not have.
    run: (args, ctx) => ctx.api.get(`/applications/${enc(args.id)}/debug/pods`),
    forModel: podDebugView,
  }),
  defineTool({
    name: 'app_releases',
    routes: ['GET /applications/:id/releases'],
    description:
      'List the deploy/rollback release history of an application, most recent first.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      id: z.string(),
      limit: coerceNumber(z.number().int().positive().max(100)).optional(),
    },
    // The route answers `{ releases }` and takes no limit, so the envelope is
    // unwrapped and the cap applied here — the tool's contract to the model
    // (a list, newest first, at most `limit` long) is unchanged.
    run: async (args, ctx) => {
      const page = await ctx.api.get<{ releases?: unknown[] }>(
        `/applications/${enc(args.id)}/releases`,
      );
      const releases = page.releases ?? [];
      return args.limit ? releases.slice(0, args.limit) : releases;
    },
  }),
  defineTool({
    name: 'app_events',
    routes: ['GET /applications/:id/events'],
    description:
      'List audit/history events for an application (deploy, rollback, scale, ...), most recent first.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      id: z.string(),
      eventType: z.string().optional(),
      limit: coerceNumber(z.number().int().positive().max(200)).optional(),
      offset: coerceNumber(z.number().int().nonnegative()).optional(),
    },
    run: (args, ctx) =>
      ctx.api.get(`/applications/${enc(args.id)}/events`, {
        type: args.eventType,
        limit: args.limit,
        offset: args.offset,
      }),
  }),
  defineTool({
    name: 'app_deploy_from_yaml',
    routes: ['POST /applications/deploy-from-yaml'],
    description:
      'Deploy a CUSTOM application from a flui.yaml manifest (kind: Application) you compose for the user. Validate it first with spec_validate. A real deploy requires a connected GitHub repository (repoFullName as owner/repo) — Flui builds it via GitHub Actions; set validateOnly:true to check the manifest without deploying or needing a repo (the response then carries effectiveYaml, the manifest as it would be applied). clusterId is optional (the sole cluster is used). Use overrides for what belongs to the installation rather than to the code: overrides.name installs the same repo and branch a SECOND time (it is part of the app identity, so pass it on every later deploy of that install), overrides.domain.fqdn gives it its own hostname, overrides.exposure switches public/internal. Overrides are remembered on the app and re-applied on later deploys, so they never silently revert to the manifest.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      yaml: z.string(),
      repoFullName: z.string().optional(),
      clusterId: z.string().optional(),
      branch: z.string().optional(),
      validateOnly: z.boolean().optional(),
      envOverrides: z.record(z.string(), z.string()).optional(),
      overrides: z
        .object({
          name: z.string().optional(),
          exposure: z.enum(['public', 'internal']).optional(),
          domain: z
            .object({
              auto: z.boolean().optional(),
              tls: z.boolean().optional(),
              fqdn: z.string().optional(),
              hostnameMode: z.enum(['ip', 'domain']).optional(),
              certChallenge: z.enum(['http-01', 'dns-01']).optional(),
              certificateProvider: z
                .enum(['lets-encrypt', 'lets-encrypt-staging'])
                .optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
    },
    run: async (args, ctx) => {
      const dto: DeployFromYamlDto = {
        yaml: args.yaml,
        clusterId: await resolveClusterId(ctx, args.clusterId),
        repoFullName: args.repoFullName ?? '',
        branch: args.branch,
        validateOnly: args.validateOnly,
        envOverrides: args.envOverrides,
        overrides: args.overrides,
      };
      // The route asks `assertCanCreate` before anything is written — a scoped
      // grant only authorises the creations its selector reaches, and a sandbox
      // guest only its own tenancy's cluster. In process none of that ran.
      return ctx.api.post('/applications/deploy-from-yaml', dto);
    },
  }),
  defineTool({
    name: 'app_deploy',
    routes: ['POST /applications/:id/deploy'],
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
    run: async (args, ctx) => {
      const dto: DeployApplicationDto = {
        imageRef: args.imageRef,
        commitSha: args.commitSha,
        buildId: args.buildId,
        useCurrentImage: args.useCurrentImage,
        reason: args.reason,
      };
      // The author is no longer this tool's to pass: the route reads it off the
      // request, so the operation and the release record carry
      // whoever the credential belongs to rather than whoever the tool said.
      const op = await ctx.api.post<Record<string, unknown>>(
        `/applications/${enc(args.id)}/deploy`,
        dto,
      );
      // Carried through so the model can name the application when it comes
      // back with operation_status — that is the route a non-administrator is
      // allowed to read the operation on.
      return { ...op, applicationId: args.id };
    },
    forModel: operationView,
  }),
  defineTool({
    name: 'app_scale',
    routes: ['PATCH /applications/:id/replicas'],
    description:
      'Set the number of running replicas for an application (0–20). Use 0 to stop it, or a higher number to scale out.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      replicas: z.number().int().min(0).max(20),
    },
    // Over the wire — a write, so the guard derives `app:write` rather than
    // `app:read`. Note what going over the wire does NOT do:
    // `AppManagementController` carries no `AppAccessGuard`, so this route is
    // as open as it was and the conversion inherits exactly that. Calling the
    // API makes its protection reach the agent; it does not invent protection
    // the API does not have.
    run: (args, ctx) =>
      ctx.api.patch(`/applications/${enc(args.id)}/replicas`, {
        replicas: args.replicas,
      }),
    forModel: runtimeView,
  }),
  defineTool({
    name: 'app_restart',
    routes: ['POST /applications/:id/restart'],
    description:
      'Trigger a rolling restart of an application (recreates its pods without changing the image or config).',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: (args, ctx) =>
      ctx.api.post(`/applications/${enc(args.id)}/restart`, {}),
    forModel: runtimeView,
  }),
  defineTool({
    name: 'app_stop',
    routes: ['POST /applications/:id/stop'],
    description:
      'Stop an application (scale it to 0 replicas). It stays deployed and can be started again later.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    // The route returns the application, not the runtime summary the service
    // method returned — same effect on the cluster, different body — so the
    // projection reads the application's own fields instead.
    run: (args, ctx) => ctx.api.post(`/applications/${enc(args.id)}/stop`, {}),
    forModel: replicaStateView,
  }),
  defineTool({
    name: 'app_start',
    routes: ['POST /applications/:id/start'],
    description:
      'Start a previously stopped application (restore its replicas and mark it running).',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.api.post(`/applications/${enc(args.id)}/start`, {}),
    forModel: replicaStateView,
  }),
  defineTool({
    name: 'app_removal_preview',
    routes: ['GET /applications/:id/removal-preview'],
    description:
      'What removing this application would take away, WITHOUT removing anything. Read this before app_delete and tell the person the `dataWarning` sentence — removal deletes the volumes too, and it cannot be undone. Also says whether the id belongs to a multi-component catalog install, in which case every component listed goes at once. If `volumesKnown` is false the cluster could not be read: an empty `volumes` then means "not known", never "no data".',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`/applications/${enc(args.id)}/removal-preview`),
    forModel: removalPreviewView,
  }),
  defineTool({
    name: 'app_delete',
    routes: ['DELETE /applications/:id/install'],
    description:
      'Remove an INSTALLED application by its id and clean up its resources, INCLUDING its persistent volumes — the data goes with it and cannot be recovered. Call app_removal_preview first and repeat its `dataWarning` to the person before doing this. Find the id with app_list first — the catalog only lists installable definitions, not what is installed. Works for both catalog-installed apps (removes the entire multi-component install) and custom apps; you do NOT need to know which it is. Returns an async operation — confirm via operation_status. Destructive.',
    scope: MCP_SCOPE.APP_DESTRUCTIVE,
    inputSchema: { id: z.string() },
    run: (args, ctx) => removeApplication(ctx, args.id),
  }),
];
