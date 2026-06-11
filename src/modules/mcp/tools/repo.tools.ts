import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

/**
 * ui_action convention (surface-agnostic): a tool may return a top-level `uiAction`
 * directive when a step needs the human's browser. Both surfaces consume the SAME
 * tool result — the MCP host shows the URL/payload as text for the user to act on;
 * the dashboard renders it as a button. The agent never performs the browser flow;
 * the URL/manifest is generated server-side.
 *  - kind 'open_url'    → open `url` in a browser (OAuth, install).
 *  - kind 'submit_form' → POST `fields` (e.g. a GitHub App manifest) to `url`.
 */
interface UiOpenUrlAction {
  uiAction: { kind: 'open_url'; url?: string; label: string };
  instructions: string;
}
interface UiSubmitFormAction {
  uiAction: {
    kind: 'submit_form';
    url: string;
    fields: Record<string, string>;
    label: string;
  };
  instructions: string;
}

/** Project-setup context: starter templates, connected repos, GitHub status (read tier). */
export const REPO_TOOLS: ToolDef[] = [
  defineTool({
    name: 'template_list',
    description:
      'List the official Flui starter templates (framework, language, version) used to scaffold a new project before deploying it.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: async (_args, ctx) => ctx.services.templates.listTemplates(),
    forModel: (data) => {
      const items = data as Array<{
        framework?: string;
        displayName?: string;
        version?: string;
        language?: string;
      }>;
      return items.map((t) => ({
        framework: t.framework,
        name: t.displayName,
        version: t.version,
        language: t.language,
      }));
    },
  }),
  defineTool({
    name: 'template_get',
    description:
      'Get one starter template by framework id (e.g. "nextjs", "fastapi", "spring-boot"), including the repository it scaffolds from.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { framework: z.string(), version: z.string().optional() },
    run: async (args, ctx) =>
      ctx.services.templates.getTemplate(args.framework, args.version),
  }),
  defineTool({
    name: 'repo_list',
    description:
      'List the GitHub repositories connected to Flui (deployable sources) for the current user.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: async (_args, ctx) =>
      ctx.services.repos.listRepositories(ctx.user.userId),
  }),
  defineTool({
    name: 'integration_status',
    description:
      'Check whether the GitHub integration is connected — required before deploying an app from a repository.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: async (_args, ctx) => ctx.services.github.getStatus(ctx.user.userId),
  }),
  defineTool({
    name: 'github_setup',
    description:
      "Admin only: configure the Flui GitHub App on THIS instance (one-time, required before anyone can connect repositories). Returns a ui_action that submits a prefilled GitHub 'create app from manifest' form — the admin confirms it in the browser and the App credentials are stored automatically. You do not create anything yourself. If GitHub is already configured, use github_connect instead.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { name: z.string().optional() },
    run: async (args, ctx) => {
      if (!ctx.user.isAdmin) {
        throw new Error('Only an admin can configure the instance GitHub App.');
      }
      const { manifestJson, githubUrl, state } =
        await ctx.services.githubManifest.buildManifestStart(ctx.user.userId, {
          name: args.name,
        });
      const action: UiSubmitFormAction = {
        uiAction: {
          kind: 'submit_form',
          url: `${githubUrl}?state=${state}`,
          fields: { manifest: JSON.stringify(manifestJson) },
          label: 'Create GitHub App',
        },
        instructions:
          'Open and confirm the GitHub form to create the Flui App; its credentials are stored automatically when you return.',
      };
      return action;
    },
  }),
  defineTool({
    name: 'github_connect',
    description:
      "Begin connecting the user's GitHub account to Flui (needed to deploy from a repository). Returns either { alreadyConnected } or a ui_action with a URL the USER opens in their browser to authorize — you do NOT perform the OAuth yourself. After they authorize, repositories can be connected.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: async (_args, ctx) => {
      const flow = await ctx.services.githubAuth.getConnectFlow(
        ctx.user.userId,
      );
      if (flow.alreadyConnected) {
        return { alreadyConnected: true, login: flow.login };
      }
      const action: UiOpenUrlAction = {
        uiAction: {
          kind: 'open_url',
          url: flow.installUrl,
          label: 'Connect GitHub',
        },
        instructions:
          'Open the link to authorize Flui on GitHub, then ask me again to continue.',
      };
      return { alreadyConnected: false, ...action };
    },
  }),
  defineTool({
    name: 'repo_connect',
    description:
      'Connect a GitHub repository to Flui so it can be deployed. Accepts "owner/repo" or a full GitHub URL. Requires GitHub already connected — if it is not, call github_connect first. The access token is resolved server-side; never ask the user for it.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { repository: z.string() },
    run: (args, ctx) => {
      const url = /^https?:\/\//.test(args.repository)
        ? args.repository
        : `https://github.com/${args.repository}`;
      return ctx.services.repos.connectRepositoryByUrl(ctx.user.userId, url);
    },
  }),
];
