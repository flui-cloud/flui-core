import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { InstallCatalogAppDto } from '../../catalog/dto/install-catalog-app.dto';
import { rankBySimilarity } from '../../catalog/utils/catalog-fuzzy.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  defineTool,
  readOperationOutcome,
  removeApplication,
  resolveClusterId,
  ToolDef,
} from './mcp-tool.util';

/** Catalog discovery tools (read tier) plus gated install (write). */
export const CATALOG_TOOLS: ToolDef[] = [
  defineTool({
    name: 'catalog_search',
    description:
      'Search the Flui catalog of installable apps and building blocks by free-text name, category, or tags. The search is tolerant: if no exact match is found it falls back to the closest apps by name similarity, so prefer searching by the app NAME the user said rather than guessing a slug. Results may be near-matches ranked by relevance — read the `name` to pick the right one (confirm with the user if ambiguous).',
    scope: MCP_SCOPE.CATALOG_READ,
    inputSchema: {
      search: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    run: async (args, ctx) => {
      const results = await ctx.services.catalog.listPublic({
        search: args.search,
        category: args.category,
        tags: args.tags,
      });
      if (results.length > 0 || !args.search) return results;
      // Substring LIKE missed — rank by similarity so a near-name still surfaces.
      const pool = await ctx.services.catalog.listPublic({
        category: args.category,
        tags: args.tags,
      });
      return rankBySimilarity(args.search, pool);
    },
    // A catalog listing can be long — the model gets the essentials.
    forModel: (data) => {
      const apps = data as Array<{
        slug?: string;
        name?: string;
        category?: string;
        description?: string;
      }>;
      return apps.map((a) => ({
        slug: a.slug,
        name: a.name,
        category: a.category,
        description: a.description,
      }));
    },
  }),
  defineTool({
    name: 'catalog_get_app',
    description:
      'Get the full detail of one catalog app by slug: required user inputs, dependencies, exposure, and whether it can be installed on the target cluster right now. ALWAYS call this before app_install and check `installable` — if it is false the install will be refused, so tell the user the missing requirement (e.g. the cluster needs DNS + TLS for internal apps) and how to resolve it instead of attempting the install. If the slug is wrong the error lists the closest slugs ("did you mean …") — retry with one of those rather than telling the user the app is absent. The cluster is auto-resolved when there is a single one.',
    scope: MCP_SCOPE.CATALOG_READ,
    inputSchema: {
      slug: z.string(),
      clusterId: z.string().optional(),
    },
    run: async (args, ctx) => {
      // Soft-resolve the cluster so installability is computed even when the model
      // omits clusterId; with several clusters and none given, fall back to undefined.
      let clusterId = args.clusterId;
      if (!clusterId) {
        try {
          clusterId = await resolveClusterId(ctx);
        } catch {
          clusterId = undefined;
        }
      }
      try {
        return await ctx.services.catalog.getDetailBySlug(args.slug, clusterId);
      } catch (err) {
        // Surface the closest slugs on a wrong guess so the model retries.
        if (!(err instanceof NotFoundException)) throw err;
        const suggestions = rankBySimilarity(
          args.slug,
          await ctx.services.catalog.listPublic({}),
        );
        if (!suggestions.length) throw err;
        const list = suggestions.map((s) => `${s.slug} (${s.name})`).join(', ');
        throw new NotFoundException(
          `Catalog app "${args.slug}" not found. Did you mean: ${list}? Retry with the exact slug.`,
        );
      }
    },
    forModel: (data) => {
      const d = data as {
        name?: string;
        slug?: string;
        version?: string;
        exposure?: string;
        installable?: boolean;
        notInstallableReason?: string;
        notInstallableDetails?: unknown;
        userInputPrompts?: Array<{ name: string; default?: string }>;
        dependencies?: Array<{ ref?: string; required?: boolean }>;
      };
      return {
        name: d.name,
        slug: d.slug,
        version: d.version,
        exposure: d.exposure,
        installable: d.installable,
        notInstallableReason: d.notInstallableReason,
        missingRequirements: d.notInstallableDetails,
        requiredInputs: (d.userInputPrompts ?? [])
          .filter((p) => p.default === undefined)
          .map((p) => p.name),
        dependencies: (d.dependencies ?? []).map((dep) => ({
          ref: dep.ref,
          required: dep.required,
        })),
      };
    },
  }),
  defineTool({
    name: 'app_install',
    description:
      "Install a catalog app on a cluster. Provide the catalog `slug` (from catalog_search) and a `displayName`. clusterId is optional (the sole cluster is used automatically). Optional: domain (a custom FQDN; omitted, Flui auto-assigns one when the cluster has DNS+TLS), authMode, exposure, options (feature toggles), userInputs (answers to the app's required inputs — call catalog_get_app first to see which are required), envOverrides. Inspect catalog_get_app before installing so required userInputs and dependencies are satisfied. Returns immediately with an operationId; the install then runs in the background. Follow the `note` in the result for what to do next — it is surface-specific.",
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      slug: z.string(),
      displayName: z.string(),
      clusterId: z.string().optional(),
      domain: z.string().optional(),
      authMode: z.enum(['native', 'oidc', 'proxy', 'none']).optional(),
      exposure: z.enum(['public', 'internal']).optional(),
      options: z.record(z.string(), z.boolean()).optional(),
      userInputs: z.record(z.string(), z.string()).optional(),
      envOverrides: z.record(z.string(), z.string()).optional(),
    },
    run: async (args, ctx) => {
      const dto: InstallCatalogAppDto = {
        clusterId: await resolveClusterId(ctx, args.clusterId),
        displayName: args.displayName,
        domain: args.domain,
        authMode: args.authMode,
        exposure: args.exposure,
        options: args.options,
        userInputs: args.userInputs,
        envOverrides: args.envOverrides,
      };
      const { install, operation } = await ctx.services.installer.install(
        args.slug,
        dto,
        ctx.user.userId,
        ctx.user.email,
      );
      const outcome = await readOperationOutcome(
        ctx,
        operation.id,
        `Install ${install.displayName}`,
      );
      return {
        installId: install.id,
        slug: args.slug,
        displayName: install.displayName,
        ...outcome,
      };
    },
  }),
  defineTool({
    name: 'app_uninstall',
    description:
      'Remove an INSTALLED app by its application id. Find the id with app_list first — the catalog only lists installable definitions, not what is installed. Removes catalog-installed apps (the entire multi-component install) as well as custom apps; you do NOT need to know which it is. Returns immediately with an operationId; removal then runs in the background. Follow the `note` in the result for what to do next — it is surface-specific. Destructive.',
    scope: MCP_SCOPE.APP_DESTRUCTIVE,
    inputSchema: { id: z.string() },
    run: (args, ctx) => removeApplication(ctx, args.id),
  }),
];
