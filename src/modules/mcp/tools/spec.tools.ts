import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { McpToolContext, runGated } from './mcp-tool.util';

/** flui.yaml validation (plan tier) — same ajv path the API enforces on install. */
export function registerSpecTools(
  server: McpServer,
  ctx: McpToolContext,
): void {
  server.registerTool(
    'spec_validate',
    {
      description:
        'Validate a flui.yaml manifest against the catalog schema (the same server-side ajv validation enforced at install). Returns validity plus any errors to fix.',
      inputSchema: {
        yaml: z.string(),
      },
    },
    (args) =>
      runGated(ctx, 'spec_validate', MCP_SCOPE.SPEC_VALIDATE, () =>
        Promise.resolve(ctx.services.catalog.validateManifest(args.yaml)),
      ),
  );
}
