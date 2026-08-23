import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

/** Path-segment safety: a value from a model is input, not a literal. */
const enc = encodeURIComponent;

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

/**
 * `owner/repo`, from either of the two things a model hands over. Anything that
 * is not a GitHub URL is taken as already being `owner/repo` and validated by
 * the route, which is where the authority is.
 */
function toOwnerRepo(repository: string): string {
  const trimmed = repository.trim().replace(/\.git$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^\/|\/$/g, '');
  try {
    const parts = new URL(trimmed).pathname.split('/').filter(Boolean);
    return parts.slice(0, 2).join('/');
  } catch {
    return trimmed;
  }
}

/** Project-setup context: starter templates, connected repos, GitHub status (read tier). */
export const REPO_TOOLS: ToolDef[] = [
  defineTool({
    name: 'template_list',
    routes: ['GET /templates'],
    description:
      'List the official Flui starter templates (framework, language, version) used to scaffold a new project before deploying it.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/templates'),
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
    routes: ['GET /templates/:framework'],
    description:
      'Get one starter template by framework id (e.g. "nextjs", "fastapi", "spring-boot"), including the repository it scaffolds from.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { framework: z.string(), version: z.string().optional() },
    run: (args, ctx) =>
      ctx.api.get(`/templates/${enc(args.framework)}`, {
        version: args.version,
      }),
  }),
  defineTool({
    name: 'repo_list',
    routes: ['GET /repositories'],
    description:
      'List the GitHub repositories connected to Flui (deployable sources) for the current user.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    // The route reads the caller off the request, so "the current user" is the
    // credential's own user and cannot be another one by mistake.
    run: (_args, ctx) => ctx.api.get('/repositories'),
  }),
  defineTool({
    name: 'integration_status',
    routes: ['GET /repositories/github/status'],
    description:
      'Check whether the GitHub integration is connected — required before deploying an app from a repository.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/repositories/github/status'),
  }),
  defineTool({
    name: 'github_setup',
    routes: ['POST /repositories/github/setup/github-app/manifest-start'],
    description:
      "Configure the Flui GitHub App on THIS instance (one-time, required before anyone can connect repositories); it needs the permission to manage integrations. Returns a ui_action that submits a prefilled GitHub 'create app from manifest' form — the person confirms it in the browser and the App credentials are stored automatically. You do not create anything yourself. If GitHub is already configured, use github_connect instead. Expect a refusal on an agent API key: `integration:manage` is carried by no `mcp:*` scope on purpose, so this one only works through the in-product assistant or a credential that declares no scopes — if it comes back CREDENTIAL_SCOPE_CEILING, say so and stop rather than retrying.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { name: z.string().optional() },
    // Decision 40: the `if (!ctx.user.isAdmin) throw` that used to stand here
    // is deleted rather than converted. The route carries
    // `@RequirePermission(INTEGRATION_MANAGE)`, and keeping a second, cruder
    // copy of the rule in the tool body would refuse an owner who holds the
    // permission without the flag — a gate that says no to someone the product
    // says yes to.
    run: async (args, ctx) => {
      const { manifestJson, githubUrl, state } = await ctx.api.post<{
        manifestJson: unknown;
        githubUrl: string;
        state: string;
      }>('/repositories/github/setup/github-app/manifest-start', {
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
    routes: ['GET /repositories/github-app/install-url'],
    description:
      "Begin connecting the user's GitHub account to Flui (needed to deploy from a repository). Returns either { alreadyConnected } or a ui_action with a URL the USER opens in their browser to authorize — you do NOT perform the OAuth yourself. After they authorize, repositories can be connected.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    // `GET /repositories/github-app/install-url` is the same flow the dashboard
    // opens — the service method this used to call exists to mirror it.
    run: async (_args, ctx) => {
      const flow = await ctx.api.get<{
        alreadyConnected: boolean;
        login?: string;
        installUrl?: string;
      }>('/repositories/github-app/install-url');
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
    routes: ['POST /repositories/import'],
    description:
      'Connect a GitHub repository to Flui so it can be deployed. Accepts "owner/repo" or a full GitHub URL. Requires GitHub already connected — if it is not, call github_connect first. The access token is resolved server-side; never ask the user for it.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { repository: z.string() },
    // `POST /repositories/import` takes `owner/repo`, resolves the token
    // server-side exactly as the by-URL service call did, and is idempotent
    // where that one threw "already connected" — so a model that connects the
    // same repository twice now gets the repository instead of an error. A
    // full URL is reduced to owner/repo here rather than server-side, because
    // this tool is what promises to accept one.
    run: async (args, ctx) => {
      const fullName = toOwnerRepo(args.repository);
      const result = await ctx.api.post<{
        repositories?: Array<{ id: string; fullName: string; status: string }>;
        errors?: string[];
      }>('/repositories/import', { repositoryIds: [fullName] });
      const connected = result.repositories?.[0];
      if (!connected) {
        // The route reports per-repository failure in the body with a 201.
        // Left as-is a model would read that as success; a throw is what makes
        // a failed connect look like a failed connect.
        throw new Error(
          result.errors?.join('; ') ??
            `GitHub repository ${fullName} could not be connected.`,
        );
      }
      return connected;
    },
  }),
];
