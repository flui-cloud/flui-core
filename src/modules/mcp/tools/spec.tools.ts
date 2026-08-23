import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

/** flui.yaml validation (plan tier) — same ajv path the API enforces on install. */
export const SPEC_TOOLS: ToolDef[] = [
  defineTool({
    name: 'spec_validate',
    routes: ['POST /catalog/validate'],
    description:
      'Validate a flui.yaml manifest against the catalog schema (the same server-side ajv validation enforced at install). Returns validity plus any errors to fix.',
    scope: MCP_SCOPE.SPEC_VALIDATE,
    inputSchema: {
      yaml: z.string(),
    },
    run: (args, ctx) => ctx.api.post('/catalog/validate', { yaml: args.yaml }),
  }),
];
