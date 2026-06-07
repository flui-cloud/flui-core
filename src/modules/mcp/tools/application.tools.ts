import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DeployApplicationDto } from '../../applications/dto/deploy-application.dto';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { AppEventType } from '../../applications/enums/app-event-type.enum';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { McpToolContext, runGated } from './mcp-tool.util';

/** Application read tools, plus gated deploy (write) and delete (destructive). */
export function registerApplicationTools(
  server: McpServer,
  ctx: McpToolContext,
): void {
  server.registerTool(
    'app_list',
    {
      description:
        'List deployed applications on a cluster, with optional category / kind / status filters. Status values are lowercase (running, degraded, failed, ...).',
      inputSchema: {
        clusterId: z.string(),
        category: z.string().optional(),
        kind: z.string().optional(),
        status: z.string().optional(),
      },
    },
    (args) =>
      runGated(ctx, 'app_list', MCP_SCOPE.APP_READ, async () => {
        const apps = await ctx.services.apps.findByClusterId(args.clusterId, {
          category: args.category as ApplicationCategory | undefined,
          kind: args.kind as ApplicationKind | undefined,
          status: args.status as ApplicationStatus | undefined,
        });
        return apps.map((a) => ctx.services.apps.toResponseDto(a));
      }),
  );

  server.registerTool(
    'app_get',
    {
      description:
        'Get one application by id: status, config, image, replicas, and any in-flight deploy/rollback operation.',
      inputSchema: { id: z.string() },
    },
    (args) =>
      runGated(ctx, 'app_get', MCP_SCOPE.APP_READ, async () => {
        const app = await ctx.services.apps.findById(args.id);
        return ctx.services.apps.toResponseDtoWithOperation(app);
      }),
  );

  server.registerTool(
    'app_events',
    {
      description:
        'List audit/history events for an application (deploy, rollback, scale, ...), most recent first.',
      inputSchema: {
        id: z.string(),
        eventType: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    (args) =>
      runGated(ctx, 'app_events', MCP_SCOPE.APP_READ, async () => {
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
      }),
  );

  server.registerTool(
    'app_deploy',
    {
      description:
        'Trigger a deploy of an existing application. Provide a specific image/commit/build, or set useCurrentImage to redeploy the current one.',
      inputSchema: {
        id: z.string(),
        imageRef: z.string().optional(),
        commitSha: z.string().optional(),
        buildId: z.string().optional(),
        useCurrentImage: z.boolean().optional(),
        reason: z.string().optional(),
      },
    },
    (args) =>
      runGated(ctx, 'app_deploy', MCP_SCOPE.APP_WRITE, () => {
        const dto: DeployApplicationDto = {
          imageRef: args.imageRef,
          commitSha: args.commitSha,
          buildId: args.buildId,
          useCurrentImage: args.useCurrentImage,
          reason: args.reason,
        };
        return ctx.services.deploy.deploy(args.id, dto, ctx.user.userId);
      }),
  );

  server.registerTool(
    'app_delete',
    {
      description:
        'Delete an application and clean up its resources. Destructive: requires the destructive scope AND server-side enablement.',
      inputSchema: { id: z.string() },
    },
    (args) =>
      runGated(ctx, 'app_delete', MCP_SCOPE.APP_DESTRUCTIVE, () =>
        ctx.services.deploy.deleteApplication(args.id, ctx.user.userId),
      ),
  );
}
