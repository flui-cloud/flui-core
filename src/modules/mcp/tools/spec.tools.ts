import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

/** flui.yaml validation (plan tier) — same ajv path the API enforces on install. */
export const SPEC_TOOLS: ToolDef[] = [
  defineTool({
    name: 'spec_validate',
    routes: ['POST /catalog/validate'],
    description:
      'Validate a `kind: CatalogApp` manifest against the catalog schema (the same server-side ajv validation enforced at install). Returns validity plus any errors to fix. This is the CATALOG contract only: a `kind: Application` manifest — the one a source repository is deployed from — comes back invalid here as the wrong kind, and belongs to `app_manifest_validate`, which also weighs it against the installation.',
    scope: MCP_SCOPE.SPEC_VALIDATE,
    inputSchema: {
      yaml: z.string(),
    },
    run: (args, ctx) => ctx.api.post('/catalog/validate', { yaml: args.yaml }),
  }),
];
