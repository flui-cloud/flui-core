import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { McpToolContext, runGated } from './mcp-tool.util';

/** Catalog discovery tools (read tier). */
export function registerCatalogTools(
  server: McpServer,
  ctx: McpToolContext,
): void {
  server.registerTool(
    'catalog_search',
    {
      description:
        'Search the Flui catalog of installable apps and building blocks. Optional filters: free-text search, category, tags.',
      inputSchema: {
        search: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    (args) =>
      runGated(ctx, 'catalog_search', MCP_SCOPE.CATALOG_READ, () =>
        ctx.services.catalog.listPublic({
          search: args.search,
          category: args.category,
          tags: args.tags,
        }),
      ),
  );

  server.registerTool(
    'catalog_get_app',
    {
      description:
        'Get the full detail of one catalog app by slug, including inputs, dependencies and (if a clusterId is given) installability on that cluster.',
      inputSchema: {
        slug: z.string(),
        clusterId: z.string().optional(),
      },
    },
    (args) =>
      runGated(ctx, 'catalog_get_app', MCP_SCOPE.CATALOG_READ, () =>
        ctx.services.catalog.getDetailBySlug(args.slug, args.clusterId),
      ),
  );
}
