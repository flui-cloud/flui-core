import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, resolveClusterId, ToolDef } from './mcp-tool.util';

/** Cluster discovery (read tier) — the entry point for any cluster-scoped tool. */
export const INFRASTRUCTURE_TOOLS: ToolDef[] = [
  defineTool({
    name: 'cluster_list',
    description:
      'List the active clusters with their ids, names and status. Only needed to pick a clusterId when SEVERAL clusters exist — cluster-scoped tools (app_list, app_logs, log_sources) already default to the sole cluster when there is one.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.services.clusters.listClusters(),
  }),
  defineTool({
    name: 'cluster_resources',
    description:
      'Get the current CPU and memory utilization of a cluster. Call this before any catalog install to verify the cluster is not already at capacity. Returns used vs total resources, available headroom, autoscaling status, and canDeploy. If canDeploy is false with reason "insufficient_resources", the cluster is at or above the 90% safety threshold — warn the user and do NOT install unless they explicitly accept the risk or enable autoscaling first.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { clusterId: z.string().optional() },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.services.clusters.checkResourceAvailability(id, 0, 0);
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
];
