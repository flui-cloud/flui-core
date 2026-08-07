import { z } from 'zod';
import { AppLogsQueryDto } from '../../observability/dto/app-logs-query.dto';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  coerceNumber,
  defineTool,
  resolveClusterId,
  ToolDef,
} from './mcp-tool.util';

/** Parse a compact relative window ("15m", "1h", "6h", "2d", "1w") to milliseconds. */
function durationToMs(since: string): number | undefined {
  const match = /^(\d+)\s*([mhdw])$/.exec(since.trim().toLowerCase());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unitMs: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return value * unitMs[match[2]];
}

/** Application logs from Loki and edge HTTP traffic from Traefik (read tier). */
export const OBSERVABILITY_TOOLS: ToolDef[] = [
  defineTool({
    name: 'app_traffic',
    description:
      'HTTP traffic for one application, measured at the ingress: request rate, status-code breakdown, error percentages and latency. Works for every routable app with no instrumentation — use it to answer "is my API healthy / slow / erroring" and to decide which window to then inspect with app_logs. Pass the application id (from app_list). `window` is the averaging window ("1m", "5m", "1h"); widen it for low-traffic apps, where a short window reads as zero. An app with no public HTTP route returns is_routable=false and null metrics — that is not an error, it simply has no edge traffic. IMPORTANT: when latency.estimates_are_coarse is true, the percentiles are artefacts of a sparse histogram — quote latency.mean_seconds instead and say the percentiles are unreliable until the cluster ships tuned buckets.',
    scope: MCP_SCOPE.OBS_READ,
    inputSchema: {
      id: z.string(),
      window: z
        .string()
        .regex(/^\d+[smhd]$/)
        .optional(),
    },
    run: async (args, ctx) => {
      const app = await ctx.services.apps.findById(args.id);
      const window = args.window ?? '5m';
      const target = {
        slug: app.slug,
        namespace: app.k8sNamespace,
        port: app.port,
        portProtocol: app.portProtocol,
      };
      return {
        app_id: app.id,
        app_name: app.slug,
        namespace: app.k8sNamespace,
        is_routable: ctx.services.traffic.isRoutable(target),
        traefik_service: ctx.services.traffic.buildTraefikServiceId(target),
        window,
        traffic: await ctx.services.traffic.getTrafficInstant(target, window),
      };
    },
  }),
  defineTool({
    name: 'app_alerts',
    description:
      'Alert history for one application — what Alertmanager fired for it, newest first, one row per episode (repeats while a condition persists update the row, they do not stack). Pass the application id (from app_list). Use it to answer "has this app been alerting", "is anything wrong right now", or to give context before reading logs. Set firing_only=true for just the active ones. Each alert has: status (firing | resolved), severity, a human summary, and timings. IMPORTANT: when resolved_by is "timeout", the alert stopped reporting without a resolve signal — treat ends_at as approximate ("last seen at", not "recovered at"), do not state the app recovered at that exact time. Absence of alerts means none were recorded, not that the app is necessarily healthy — pair with app_traffic for a live read.',
    scope: MCP_SCOPE.OBS_READ,
    inputSchema: {
      id: z.string(),
      firing_only: z.boolean().optional(),
      limit: coerceNumber(z.number().int().positive().max(200)).optional(),
    },
    run: async (args, ctx) => {
      const app = await ctx.services.apps.findById(args.id);
      const rows = await ctx.services.alertEvents.listByApplication(app.id, {
        status: args.firing_only ? 'firing' : undefined,
        limit: args.limit ?? 50,
      });
      return {
        app_id: app.id,
        app_name: app.slug,
        firing: rows.filter((r) => r.status === 'firing').length,
        alerts: rows.map((r) => ({
          id: r.id,
          status: r.status,
          resolved_by: r.resolvedBy ?? null,
          alertname: r.alertname,
          severity: r.severity,
          summary: r.annotations?.summary ?? r.alertname,
          description: r.annotations?.description ?? null,
          starts_at: r.startsAt.toISOString(),
          ends_at: r.endsAt ? r.endsAt.toISOString() : null,
          last_seen_at: r.lastSeenAt.toISOString(),
        })),
      };
    },
  }),
  defineTool({
    name: 'log_sources',
    description:
      'List the queryable log sources for a cluster: the exact `app` and `namespace` label values Loki has indexed. Call this BEFORE app_logs whenever you do not already know the exact label — they are lowercase indexed labels (e.g. app "flui-web", namespace "flui-control"), NOT display names. app_logs uses exact-match, so a guessed name returns nothing. clusterId is optional: omitted with a single cluster, it is resolved automatically.',
    scope: MCP_SCOPE.OBS_READ,
    inputSchema: { clusterId: z.string().optional() },
    run: async (args, ctx) =>
      ctx.services.loki.getLogSources(
        await resolveClusterId(ctx, args.clusterId),
      ),
  }),
  defineTool({
    name: 'app_logs',
    description:
      'Fetch recent application logs from Loki for a cluster and DISPLAY them to the user. clusterId is optional (a single cluster is resolved automatically). `app` and `namespace` are EXACT lowercase indexed labels (e.g. "flui-web", "flui-control"), not display names — if unsure, call log_sources first. Narrow what is shown with filters: level, free-text search, stream, container, and a time window. Time window: pass `since` as a relative window ("15m", "1h", "6h", "24h", "2d", "7d") or `start`/`end` ISO timestamps; default is the last 24h. For an open-ended request prefer a SHORT window (since="1h") or ask the user which app and window they want, instead of dumping 24h. IMPORTANT: you receive only metadata about the result (counts), never the log lines — do not summarize, quote, or diagnose log contents from this call. If the user wants analysis, they select specific lines in the viewer and those lines are sent to you as text.',
    scope: MCP_SCOPE.OBS_READ,
    inputSchema: {
      clusterId: z.string().optional(),
      namespace: z.string().optional(),
      app: z.string().optional(),
      container: z.string().optional(),
      stream: z.enum(['stdout', 'stderr']).optional(),
      level: z.string().optional(),
      search: z.string().optional(),
      since: z.string().optional(),
      tail: coerceNumber(z.number().int().positive().max(10000)).optional(),
      start: z.string().optional(),
      end: z.string().optional(),
    },
    run: async (args, ctx) => {
      const { clusterId, since, ...rest } = args;
      // Relative window is a convenience for the model; an explicit start wins.
      let start = rest.start;
      if (!start && since) {
        const ms = durationToMs(since);
        if (ms) start = new Date(Date.now() - ms).toISOString();
      }
      const query: AppLogsQueryDto = { tail: 200, ...rest, start };
      return ctx.services.loki.getAppLogs(
        await resolveClusterId(ctx, clusterId),
        query,
      );
    },
    // Logs are bulky AND deterministic: the model gets only metadata, the full
    // logs are rendered to the user. The model must NOT analyze from this — a
    // re-query would still only return metadata. Analysis is done on the lines
    // the user selects in the viewer (sent back as plain text).
    forModel: (data) => {
      const d = data as {
        app?: string;
        namespace?: string;
        count?: number;
        logs?: unknown[];
      };
      const count = d.count ?? d.logs?.length ?? 0;
      if (count === 0) {
        // A common cause is an app/namespace that is not an exact indexed label.
        // Steer to discovery instead of letting the model repeat the same query.
        return {
          app: d.app,
          namespace: d.namespace,
          count: 0,
          displayed: true,
          note: 'No log lines matched. The app or namespace may not be an exact match (they are lowercase, e.g. "flui-web"/"flui-control"), or the time window is too narrow. List the available log sources to get valid names, or widen the time window, then try once more — do not repeat the same query. Phrase any explanation to the user in plain terms, without internal tool or parameter names.',
        };
      }
      return {
        app: d.app,
        count,
        displayed: true,
        note: 'The matching lines are rendered to the user and are NOT included in this result, so do not claim to quote or analyze them from here. Tell the user the logs are displayed. If they want analysis they will select specific lines and send them as text in a later message — analyze THOSE directly when they arrive.',
      };
    },
  }),
];
