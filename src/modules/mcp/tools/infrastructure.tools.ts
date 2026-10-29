import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, resolveClusterId, ToolDef } from './mcp-tool.util';

const enc = encodeURIComponent;

/** Cluster discovery (read tier) — the entry point for any cluster-scoped tool. */
export const INFRASTRUCTURE_TOOLS: ToolDef[] = [
  defineTool({
    name: 'cluster_list',
    summary:
      'Active clusters with ids, names and status. Only needed when there are several.',
    routes: ['GET /infrastructure/clusters'],
    description:
      'List the active clusters with their ids, names and status. Only needed to pick a clusterId when SEVERAL clusters exist — cluster-scoped tools (app_list, app_logs, log_sources) already default to the sole cluster when there is one.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/infrastructure/clusters'),
  }),
  defineTool({
    name: 'cluster_resources',
    summary:
      'CPU and memory use of a cluster and whether an app of a given size would fit (canDeploy, reasonMessage).',
    routes: ['GET /infrastructure/clusters/:id/resource-availability'],
    description:
      'Get the current CPU and memory utilization of a cluster, and whether an app of a given size would run. Call this before any install; pass cpuMillicores, memoryMi and replicas to ask about that app instead of just the headroom. Returns used vs total resources, canDeploy, and — when the free total is not enough — `placement`: whether it still fits on one node, which machine the scaling group would add as a node (verdict "buys", with price) or only propose because the group is manual ("proposes"), or that no machine it may add can take it and the app would wait ("nothing-hosts", with `why` machine by machine). Say `reasonMessage` to the person; never promise a node unless the verdict is "buys".',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      clusterId: z.string().optional(),
      cpuMillicores: z.number().int().positive().optional(),
      memoryMi: z.number().int().positive().optional(),
      replicas: z.number().int().min(1).max(20).optional(),
    },
    // `?cpuRequest=1&memoryRequest=1` and not the in-process `(id, 0, 0)`: the
    // route parses those query values with `Number.parseInt(x) || default`, so
    // a literal 0 is falsy and silently becomes the 100m/128Mi default. One
    // millicore and one mebibyte is the closest the route lets a caller get to
    // "just tell me the headroom", and the difference is below the rounding of
    // every number in the answer.
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(
        `/infrastructure/clusters/${encodeURIComponent(id)}/resource-availability`,
        {
          cpuRequest: args.cpuMillicores ?? 1,
          memoryRequest: args.memoryMi ?? 1,
          replicas: args.replicas ?? 1,
        },
      );
    },
    forModel: (data) => {
      const d = data as {
        canDeploy: boolean;
        reason: string | null;
        reasonMessage?: string | null;
        placement?: unknown;
        autoscalingEnabled: boolean;
        used: { cpu: string; memory: string };
        total: { cpu: string; memory: string };
        available: { cpu: string; memory: string };
      };

      const parseMi = (s: string): number => {
        if (s.endsWith('Gi')) return Math.round(Number.parseFloat(s) * 1024);
        return Number.parseFloat(s) || 0;
      };
      const parseMc = (s: string): number => {
        if (s.endsWith('m')) return Number.parseInt(s, 10) || 0;
        return Math.round((Number.parseFloat(s) || 0) * 1000);
      };

      const memUsed = parseMi(d.used.memory);
      const memTotal = parseMi(d.total.memory);
      const cpuUsed = parseMc(d.used.cpu);
      const cpuTotal = parseMc(d.total.cpu);

      const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
      const cpuPct = cpuTotal > 0 ? Math.round((cpuUsed / cpuTotal) * 100) : 0;

      let warning: string | undefined;
      if (!d.canDeploy && d.reason === 'insufficient_resources') {
        warning =
          d.reasonMessage ??
          `Cluster has no room for this (memory: ${memPct}%, CPU: ${cpuPct}% reserved): it would wait until a node is added. Tell the person before installing.`;
      } else if (memPct >= 80 || cpuPct >= 80) {
        warning = `Cluster is under significant pressure (memory: ${memPct}%, CPU: ${cpuPct}%). Installing additional apps is risky. Inform the user before proceeding.`;
      }

      return {
        canDeploy: d.canDeploy,
        reason: d.reason,
        reasonMessage: d.reasonMessage ?? null,
        placement: d.placement ?? null,
        autoscalingEnabled: d.autoscalingEnabled,
        memoryUsedPct: memPct,
        cpuUsedPct: cpuPct,
        used: d.used,
        total: d.total,
        available: d.available,
        ...(warning ? { warning } : {}),
      };
    },
  }),
  defineTool({
    name: 'cluster_orphaned_volumes',
    routes: ['GET /infrastructure/clusters/:id/storage/orphaned-claims'],
    description:
      'Persistent volumes on a cluster that no application owns any more — storage left behind by uninstalls that happened before Flui learned to take the volume with the application. Reports each claim with its size, its namespace, and the deleted application it belonged to when that is still known. READ ONLY: deleting one of these destroys the data in it for good, and that is deliberately not something an agent can do — tell the person what you found and point them at `flui cluster volumes --remove <namespace>/<name>` or the Storage tab of the cluster. The list errs on the side of missing things: a plain unlabelled claim from a third-party chart is never reported, so an empty answer means "none found by these rules", not "none exist". If `note` is set the scan could not run at all and the empty list proves nothing.',
    // Not `mcp:app:read`, which is where its two neighbours in this file sit.
    // The listing scans every namespace Flui puts applications in, so it
    // answers for the whole instance and not for the caller's own things — and
    // `mcp:app:read` lives in `apps:look`, a group a sandbox guest may confer
    // to its own agent. `mcp:backup:read` is the read scope whose `requires` is
    // `cluster:manage`, which is exactly the bar the route itself sets through
    // the `infrastructure` section, and whose `allows` is `cluster:read`, which
    // is exactly what the route asks for. Conferring it and reaching it are the
    // same bar, which is the property worth having.
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: { clusterId: z.string().optional() },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(
        `/infrastructure/clusters/${encodeURIComponent(id)}/storage/orphaned-claims`,
      );
    },
    // The whole list would be one long row per claim of fields the model has no
    // use for (storage class, phase, creation timestamp). What it needs to say
    // a useful sentence is: how much is being held, by what, and from which
    // dead application.
    forModel: (data) => {
      const d = data as {
        claims: Array<{
          name: string;
          namespace: string;
          sizeLabel: string;
          lastKnownApplication?: { name: string; deletedAt: string | null };
          reason: string;
        }>;
        totalLabel: string;
        namespacesScanned: string[];
        note?: string;
      };
      return {
        total: d.totalLabel,
        count: d.claims.length,
        namespacesScanned: d.namespacesScanned.length,
        removeWith: 'flui cluster volumes --remove <namespace>/<name>',
        claims: d.claims.map((c) => ({
          ref: `${c.namespace}/${c.name}`,
          size: c.sizeLabel,
          fromApplication: c.lastKnownApplication?.name ?? null,
          why: c.reason,
        })),
        ...(d.note ? { note: d.note } : {}),
      };
    },
  }),
  defineTool({
    name: 'control_restore_plan',
    routes: ['GET /infrastructure/clusters/control-restore/plan'],
    description:
      "For an installation rebuilt from a platform backup: which applications of the control cluster it was restored from can come back onto this installation's own control cluster, what each one's data comes back from (`restores`), what comes back empty or thin (`warnings`), which applications each waits for (`after` — databases first), and whether the whole restore can start (`refusals` empty). `candidates` lists every earlier control cluster that still has applications; pass `from` (its id) only when there is more than one. Read-only; to start it call control_restore_apps.",
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: { from: z.string().optional() },
    run: (args, ctx) =>
      ctx.api.get(
        '/infrastructure/clusters/control-restore/plan',
        args.from ? { from: args.from } : undefined,
      ),
  }),
  defineTool({
    name: 'control_restore_apps',
    routes: ['POST /infrastructure/clusters/control-restore'],
    description:
      "Start restoring the applications of the earlier control cluster onto this installation's control cluster, as planned by control_restore_plan (call that first and show the person its refusals and warnings). Refused when the plan has any refusal. Per application, dependencies first: records re-pointed, database and volumes restored from the latest backups, deployed, names moved. Returns an operation id for operation_status; the operation's metadata.apps lists each application's phase as it lands. Running it again continues whatever did not finish. includeStopped also restores applications that were not running.",
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      from: z.string().optional(),
      includeStopped: z.boolean().optional(),
    },
    run: (args, ctx) =>
      ctx.api.post('/infrastructure/clusters/control-restore', {
        ...(args.from ? { from: args.from } : {}),
        ...(args.includeStopped ? { includeStopped: true } : {}),
      }),
  }),
  defineTool({
    name: 'cluster_replicated_volumes_get',
    routes: ['GET /infrastructure/clusters/:id/replicated-volumes'],
    description:
      'Whether a cluster offers replicated volumes (pass the cluster id). A replicated volume keeps a synchronous copy in a second location, so an application with one writer comes back there, with its data, when its server or its location is lost; the third location only votes. `enabled` says whether the `flui-replicated` storage class exists; `storageNodes` are the nodes holding copies; `warnings` names copies an application could not follow; `plan` is what enabling would do now (`zones`, `storageNodes`, `tieBreakers`) or why it cannot (`reason`), including a cluster not yet highly available across three locations. An application asks for it with `replicated: true` on a volume in flui.yaml, and moves only if every volume it mounts is replicated. Read-only; to turn it on call cluster_replicated_volumes_enable.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) =>
      ctx.api.get(
        `/infrastructure/clusters/${enc(args.id)}/replicated-volumes`,
      ),
  }),
  defineTool({
    name: 'cluster_replicated_volumes_enable',
    routes: ['POST /infrastructure/clusters/:id/replicated-volumes'],
    description:
      'Enable replicated volumes on a cluster (pass the cluster id). A node in each of the two locations for data sets aside `sizeGiB` of its own disk (default 20) for copies, the volume engine is installed and the `flui-replicated` storage class appears; the third location casts the tie-breaking vote; existing volumes do not change. `nodes` picks the two nodes, otherwise Flui does. Refused with the reason when the cluster is not yet highly available across three locations of a validated region (`force` accepts a region Flui has not validated), or lacks a node that takes applications in a location for data. A person approves it before it happens. Returns the operation; follow it with operation_status.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      id: z.string(),
      nodes: z.array(z.string()).length(2).optional(),
      sizeGiB: z.number().int().min(5).max(2000).optional(),
      force: z.boolean().optional(),
    },
    run: (args, ctx) =>
      ctx.api.post(
        `/infrastructure/clusters/${enc(args.id)}/replicated-volumes`,
        {
          ...(args.nodes && { nodes: args.nodes }),
          ...(args.sizeGiB && { sizeGiB: args.sizeGiB }),
          ...(args.force && { force: args.force }),
        },
      ),
  }),
  defineTool({
    name: 'cluster_disks_get',
    routes: ['GET /infrastructure/clusters/:id/storage/disks'],
    description:
      'How much room is left on each node of a cluster (pass the cluster id): its own disk (`disk`), where databases and data kept on the node live, and the space set aside for copies of replicated volumes (`copies`, null where the node holds none), as total and free GiB. `warnings` names a node running short: a full disk stops what is kept on it from growing, a full space for copies refuses new or larger replicated volumes. Read-only.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`/infrastructure/clusters/${enc(args.id)}/storage/disks`),
  }),
  defineTool({
    name: 'cluster_ha_add_node',
    routes: ['POST /infrastructure/clusters/:id/high-availability/nodes'],
    description:
      'Add the node a cluster still needs to survive the loss of a location (pass the cluster id): `role` `server` (also runs the control plane and holds a vote) or `data-host` (takes applications where copies of data live), and `zone`, a location cluster_ha_get lists under `missing` for that role. Flui buys one machine there, of `serverType` or the cluster size, and joins it with its role; scaling never removes it. Anything not missing is refused with the reason. With two servers the cluster is more fragile than with one until the third joins, so add them one after the other. A person approves it before it happens. Returns the operation; follow it with operation_status.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      id: z.string(),
      role: z.enum(['server', 'data-host']),
      zone: z.string(),
      serverType: z.string().optional(),
      force: z.boolean().optional(),
    },
    run: (args, ctx) =>
      ctx.api.post(
        `/infrastructure/clusters/${enc(args.id)}/high-availability/nodes`,
        {
          role: args.role,
          zone: args.zone,
          ...(args.serverType && { serverType: args.serverType }),
          ...(args.force && { force: args.force }),
        },
      ),
  }),
  defineTool({
    name: 'cluster_ha_get',
    routes: ['GET /infrastructure/clusters/:id/high-availability'],
    description:
      'What a cluster survives with the nodes it has now (pass the cluster id), as plain sentences in `survives` and `doesNotSurvive`, and its `level`: `standard` or `three-locations` (a server in each of three locations of a validated region, copies of data in the two closest, the third voting only). `topology` names each location with its role, servers and hosts for data, or is null with the reason in `unsupported`; `missing` lists the roles still needed (`server`, `data-host`), where and why; `warnings` flags two servers, which are more fragile than one; cluster_ha_add_node adds what is missing. `observed` is what Flui last measured (as of `observed.at`): where the etcd leader is, the round trip in ms between each pair of locations, and the server Flui reaches the cluster through. Read-only.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`/infrastructure/clusters/${enc(args.id)}/high-availability`),
  }),
];
