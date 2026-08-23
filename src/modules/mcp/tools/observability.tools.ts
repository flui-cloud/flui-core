import { z } from 'zod';
import { AppLogsQueryDto } from '../../observability/dto/app-logs-query.dto';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  coerceNumber,
  defineTool,
  resolveClusterId,
  ToolDef,
} from './mcp-tool.util';

/** Path-segment safety: an id from a model is input, not a literal. */
const enc = encodeURIComponent;

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
    routes: ['GET /observability/applications/:id/traffic'],
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
    // The route builds the same envelope this tool used to assemble by hand —
    // app_id, app_name, namespace, is_routable, traefik_service, window,
    // traffic — plus cluster_id and queried_at, and it carries AppAccessGuard.
    run: (args, ctx) =>
      ctx.api.get(`/observability/applications/${enc(args.id)}/traffic`, {
        window: args.window,
      }),
  }),
  defineTool({
    name: 'app_alerts',
    routes: ['GET /observability/applications/:id/alerts'],
    description:
      'Alert history for one application — what Alertmanager fired for it, newest first, one row per episode (repeats while a condition persists update the row, they do not stack). Pass the application id (from app_list). Use it to answer "has this app been alerting", "is anything wrong right now", or to give context before reading logs. Set firing_only=true for just the active ones. Each alert has: status (firing | resolved), severity, a human summary, and timings. IMPORTANT: when resolved_by is "timeout", the alert stopped reporting without a resolve signal — treat ends_at as approximate ("last seen at", not "recovered at"), do not state the app recovered at that exact time. Absence of alerts means none were recorded, not that the app is necessarily healthy — pair with app_traffic for a live read.',
    scope: MCP_SCOPE.OBS_READ,
    inputSchema: {
      id: z.string(),
      firing_only: z.boolean().optional(),
      limit: coerceNumber(z.number().int().positive().max(200)).optional(),
    },
    // The route flattens each episode to the same fields this tool used to
    // flatten by hand, and counts the firing ones itself. `app_name` comes off
    // the rows rather than from a second read of the application: with no
    // alerts there is no name to report, which is honest — and the id the
    // caller passed is echoed either way.
    run: async (args, ctx) => {
      const page = await ctx.api.get<{
        alerts: Array<Record<string, unknown>>;
        firing: number;
      }>(`/observability/applications/${enc(args.id)}/alerts`, {
        status: args.firing_only ? 'firing' : undefined,
        limit: args.limit ?? 50,
      });
      return {
        app_id: args.id,
        app_name: page.alerts[0]?.application_slug,
        firing: page.firing,
        alerts: page.alerts,
      };
    },
  }),
  defineTool({
    name: 'log_sources',
    routes: ['GET /observability/clusters/:clusterId/apps/log-sources'],
    description:
      'List the queryable log sources for a cluster: the exact `app` and `namespace` label values Loki has indexed. Call this BEFORE app_logs whenever you do not already know the exact label — they are lowercase indexed labels (e.g. app "flui-web", namespace "flui-control"), NOT display names. app_logs uses exact-match, so a guessed name returns nothing. clusterId is optional: omitted with a single cluster, it is resolved automatically.',
    scope: MCP_SCOPE.OBS_READ,
    inputSchema: { clusterId: z.string().optional() },
    // Over the wire, on a route added for it. The label inventory of a whole
    // cluster names every tenant's applications and namespaces, so the route
    // sits behind the infrastructure section — the same gate as `loki/debug`
    // beside it. A tenant does not need this at all: their own application's
    // logs are read by id, with no discovery step.
    run: async (args, ctx) =>
      ctx.api.get(
        `/observability/clusters/${enc(
          await resolveClusterId(ctx, args.clusterId),
        )}/apps/log-sources`,
      ),
  }),
  defineTool({
    name: 'app_logs',
    routes: [
      'GET /observability/applications/:id/logs',
      'GET /observability/clusters/:clusterId/apps/logs',
    ],
    description:
      'Fetch recent application logs and DISPLAY them to the user. PREFER `applicationId` (from app_list): it reads the logs of that one application through its own record, needs no labels and no cluster, and is the only form available to a caller who may operate applications but not search the whole cluster. Without it this becomes a cluster-wide label search: clusterId is optional (a single cluster is resolved automatically), and `app` and `namespace` are then EXACT lowercase indexed labels (e.g. "flui-web", "flui-control"), not display names — if unsure, call log_sources first. Narrow what is shown with filters: level, free-text search, stream, container, and a time window. Time window: pass `since` as a relative window ("15m", "1h", "6h", "24h", "2d", "7d") or `start`/`end` ISO timestamps; default is the last 24h. For an open-ended request prefer a SHORT window (since="1h") or ask the user which app and window they want, instead of dumping 24h. IMPORTANT: you receive only metadata about the result (counts), never the log lines — do not summarize, quote, or diagnose log contents from this call. If the user wants analysis, they select specific lines in the viewer and those lines are sent to you as text.',
    scope: MCP_SCOPE.OBS_READ,
    inputSchema: {
      applicationId: z.string().optional(),
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
      const { applicationId, clusterId, since, ...rest } = args;
      // Relative window is a convenience for the model; an explicit start wins.
      let start = rest.start;
      if (!start && since) {
        const ms = durationToMs(since);
        if (ms) start = new Date(Date.now() - ms).toISOString();
      }
      const query: AppLogsQueryDto = { tail: 200, ...rest, start };

      // Naming an application takes the route that belongs to it, and that is
      // the branch that matters for everyone who is not an administrator. The
      // cluster-wide search below reads every tenant's namespace at once, so it
      // sits behind the boolean; converting this tool to HTTP inherited that
      // gate and, with it, took the logs away from the editor — and from the
      // sandbox guest — who may operate an application but not search a
      // cluster. Here the namespace and the container come off the application
      // row instead of from the caller, so `AppAccessGuard` on the route can
      // answer the only question there is: is this application yours.
      if (applicationId) {
        return ctx.api.get(
          `/observability/applications/${enc(applicationId)}/logs`,
          {
            // The label filters are dropped rather than forwarded: the route
            // derives both from the application row, and a `namespace` the
            // model guessed would either be ignored or contradict it.
            stream: query.stream,
            level: query.level,
            search: query.search,
            tail: query.tail,
            start: query.start,
            end: query.end,
          },
        );
      }

      // Decision 6 pairs giving the cluster-wide route the infrastructure
      // section with moving `flui app logs` to the per-application route; until
      // then it stays on the boolean, and this is the branch an administrator
      // reaches when they search by label across a whole cluster.
      return ctx.api.get(
        `/observability/clusters/${enc(
          await resolveClusterId(ctx, clusterId),
        )}/apps/logs`,
        query as unknown as Record<string, unknown>,
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
