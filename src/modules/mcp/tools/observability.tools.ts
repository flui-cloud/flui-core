import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppLogsQueryDto } from '../../observability/dto/app-logs-query.dto';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { McpToolContext, runGated } from './mcp-tool.util';

/** Application logs from Loki (read tier). */
export function registerObservabilityTools(
  server: McpServer,
  ctx: McpToolContext,
): void {
  server.registerTool(
    'app_logs',
    {
      description:
        'Fetch recent application logs from Loki for a cluster. Filter by namespace, app, container, stream, level, free-text search, and time range.',
      inputSchema: {
        clusterId: z.string(),
        namespace: z.string().optional(),
        app: z.string().optional(),
        container: z.string().optional(),
        stream: z.enum(['stdout', 'stderr']).optional(),
        level: z.string().optional(),
        search: z.string().optional(),
        tail: z.number().int().positive().max(10000).optional(),
        start: z.string().optional(),
        end: z.string().optional(),
      },
    },
    (args) =>
      runGated(ctx, 'app_logs', MCP_SCOPE.OBS_READ, () => {
        const { clusterId, ...rest } = args;
        const query: AppLogsQueryDto = {
          tail: 200,
          ...rest,
        } as AppLogsQueryDto;
        return ctx.services.loki.getAppLogs(clusterId, query);
      }),
  );
}
