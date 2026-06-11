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

/** Application logs from Loki (read tier). */
export const OBSERVABILITY_TOOLS: ToolDef[] = [
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
