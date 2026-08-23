import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, resolveClusterId, ToolDef } from './mcp-tool.util';

/** Cluster discovery (read tier) — the entry point for any cluster-scoped tool. */
export const INFRASTRUCTURE_TOOLS: ToolDef[] = [
  defineTool({
    name: 'cluster_list',
    routes: ['GET /infrastructure/clusters'],
    description:
      'List the active clusters with their ids, names and status. Only needed to pick a clusterId when SEVERAL clusters exist — cluster-scoped tools (app_list, app_logs, log_sources) already default to the sole cluster when there is one.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/infrastructure/clusters'),
  }),
  defineTool({
    name: 'cluster_resources',
    routes: ['GET /infrastructure/clusters/:id/resource-availability'],
    description:
      'Get the current CPU and memory utilization of a cluster. Call this before any catalog install to verify the cluster is not already at capacity. Returns used vs total resources, available headroom, autoscaling status, and canDeploy. If canDeploy is false with reason "insufficient_resources", the cluster is at or above the 90% safety threshold — warn the user and do NOT install unless they explicitly accept the risk or enable autoscaling first.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { clusterId: z.string().optional() },
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
        { cpuRequest: 1, memoryRequest: 1 },
      );
    },
    forModel: (data) => {
      const d = data as {
        canDeploy: boolean;
        reason: string | null;
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
        warning = `Cluster is at capacity (memory: ${memPct}%, CPU: ${cpuPct}%). Do NOT install — it will destabilize running workloads. Free up resources or add a worker node first.`;
      } else if (memPct >= 80 || cpuPct >= 80) {
        warning = `Cluster is under significant pressure (memory: ${memPct}%, CPU: ${cpuPct}%). Installing additional apps is risky. Inform the user before proceeding.`;
      }

      return {
        canDeploy: d.canDeploy,
        reason: d.reason,
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
];
