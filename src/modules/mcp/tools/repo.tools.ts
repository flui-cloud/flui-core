import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  McpToolContext,
  defineTool,
  resolveClusterId,
  ToolDef,
} from './mcp-tool.util';
import { UiOpenUrlAction, UiSubmitFormAction } from './handover';
import {
  MapDetail,
  projectRepositoryApply,
  projectRepositoryMap,
  unitIdsOf,
} from './repo-map.views';

/** Path-segment safety: a value from a model is input, not a literal. */
const enc = encodeURIComponent;

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a connected repository is listed back. Two spellings, both seen. */
interface ConnectedRepo {
  id: string;
  repositoryFullName?: string;
  fullName?: string;
}

const nameOf = (repo: ConnectedRepo): string =>
  repo.repositoryFullName ?? repo.fullName ?? '';

/**
 * The repository id the map routes take, from what a model can actually know.
 *
 * An agent reads `owner/repo` off a checkout, a URL off a browser and a UUID
 * off nothing at all — so demanding the id would mean a `repo_list` round trip
 * before every call, and a model that guesses one gets a 404 it cannot learn
 * from. A value already shaped like an id is passed straight through; anything
 * else is looked up in the caller's own connected repositories, which is the
 * list the route would decide against anyway.
 */
async function resolveRepositoryId(
  ctx: McpToolContext,
  repository: string,
): Promise<string> {
  const raw = repository.trim();
  if (UUID.test(raw)) return raw;
  const fullName = toOwnerRepo(raw);
  const connected = await ctx.api.get<ConnectedRepo[]>('/repositories');
  const match = connected.find(
    (repo) => nameOf(repo).toLowerCase() === fullName.toLowerCase(),
  );
  if (match) return match.id;
  // Named as a "not connected yet" problem rather than a "not found" one,
  // because the two have different remedies and only one of them is repo_connect.
  const known = connected.map(nameOf).filter(Boolean).slice(0, 20).join(', ');
  throw new Error(
    `The repository "${fullName}" is not connected to this Flui installation, so there is nothing to read. ` +
      `Connect it first with repo_connect, then call this again. ` +
      (known
        ? `Connected right now: ${known}.`
        : 'No repositories are connected at all.'),
  );
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
  defineTool({
    name: 'repo_map',
    routes: ['POST /repositories/:id/map'],
    description:
      'Read a connected GitHub repository and report what it says about ITSELF: deployable units, the services it wants (databases, caches, queues, search), the variables it requires, external dependencies, blockers, caveats, open questions, a verdict from a closed taxonomy, and one rendered flui.yaml per unit — every fact carrying its `file:line` citation and its confidence (declared / derived / circumstantial), so you can check a claim instead of trusting it. READ-ONLY: nothing is deployed, provisioned, written or committed, and no branch is touched. ' +
      'This is ONE way to reach a deploy and not the required one: if you already have an image, app_deploy_image ships it; if you would rather write the manifest yourself, app_manifest_validate + app_deploy_from_yaml is shorter and stands equal. Reach for this when you want the repository — rather than your own reading of it — to be where the facts come from. ' +
      'Accepts "owner/repo", a GitHub URL, or the repository id. `clusterId` decides half the verdict: capacity is weighed against that cluster, and with one cluster it is chosen for you. ' +
      '`detail` defaults to "decision": citations, confidences, the full read boundary, the whole verdict, every blocker/caveat/question with its evidence, and every required input BY NAME are kept; what is dropped is duplication — the second machine-readable copy of each citation (`evidence[]`), the prose in `inputs[].reason`, the per-unit `env[]` (summarised by role) and `render.units[].manifest` (the same manifest as `yaml`). Ask for "evidence" to get those back, or "full" for the untouched response — a 4000-file repository at "full" is around 180 KB. `unitId` narrows every list to one unit, which is what makes a monorepo readable one unit at a time. ' +
      'Nothing is cached: each call re-reads the branch, so compare `read.commitSha` before treating two answers as one. To act on what comes back, use repo_map_apply.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      repository: z.string(),
      branch: z.string().optional(),
      clusterId: z.string().optional(),
      unitId: z.string().optional(),
      detail: z.enum(['decision', 'evidence', 'full']).optional(),
    },
    // The projection is done here rather than in `forModel` because it depends
    // on an argument, and `forModel` is handed the result alone. A default that
    // could not be turned off would be the oracle this tool must not be.
    run: async (args, ctx) => {
      const detail: MapDetail = args.detail ?? 'decision';
      const repositoryId = await resolveRepositoryId(ctx, args.repository);
      // Never omitted quietly. Without a cluster the verdict answers only the
      // repository half and says so in `capacity.assessed:false`, and a
      // `deployable` that was never weighed against a cluster must not be
      // handed back looking like one that was.
      const clusterId = await resolveClusterId(ctx, args.clusterId);
      const query = new URLSearchParams({ clusterId });
      if (args.branch) query.set('branch', args.branch);
      const map = await ctx.api.post(
        `/repositories/${enc(repositoryId)}/map?${query.toString()}`,
      );
      if (args.unitId) {
        const ids = unitIdsOf(map);
        if (!ids.includes(args.unitId)) {
          // Silently answering with empty arrays would read as "this unit has
          // nothing in it", which is the one wrong answer a model cannot detect.
          throw new Error(
            `This repository has no unit "${args.unitId}". Units mapped at this commit: ${ids.length ? ids.join(', ') : '(none)'}. Call again without unitId to see the whole map.`,
          );
        }
      }
      return projectRepositoryMap(map, detail, args.unitId);
    },
  }),
  defineTool({
    name: 'repo_map_apply',
    routes: ['POST /repositories/:id/map/apply'],
    description:
      'Act on the map of a connected repository. Flui cuts its OWN branch `flui/deploy-<sha7>` at the exact commit the map was read from, lands ONE commit on it carrying the rendered flui.yaml and a build workflow per unit, and creates one application per unit on that branch. The branch you name is READ and cut from, never written to; the applications created carry a different identity from anything deployed off the author’s branch, so an apply cannot overwrite a production app. ' +
      'This WRITES to a real GitHub repository and spends its GitHub Actions minutes. It is one route among equals, not the sanctioned one: app_deploy_image (your own image) and app_deploy_from_yaml (your own manifest) reach a running app without touching the repository at all. ' +
      'Call repo_map first and read its verdict — an apply is refused outright when the verdict is `blocked`, `insufficient_capacity` or `not_assessed`, and that refusal is an error you cannot retry your way out of: fix what the map named, or deploy by another route. ' +
      'A person is asked before this runs. If the answer comes back as input_required, NOTHING happened and nothing failed: say what you asked for, and once they have answered, repeat the IDENTICAL call — changing the arguments raises a second request instead of getting past this one. ' +
      'What comes back: the branch, the single commit, and per unit its applicationId, whether it was armed, and `pendingInputs` — the secret variables it declared and still has no value for. Ask a person for each with app_variable_request; you must not carry a secret value yourself. When `partial` is true the commit is real and every build is running, so do NOT repeat the call — read `units[].reason`.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      repository: z.string(),
      clusterId: z.string().optional(),
      branch: z.string().optional(),
      unitIds: z.array(z.string()).optional(),
    },
    run: async (args, ctx) => {
      const repositoryId = await resolveRepositoryId(ctx, args.repository);
      // Required by the route, and required for a reason: the verdict this
      // apply is allowed to proceed on is a function of (repository, cluster).
      const clusterId = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.post(`/repositories/${enc(repositoryId)}/map/apply`, {
        clusterId,
        branch: args.branch,
        unitIds: args.unitIds,
      });
    },
    forModel: projectRepositoryApply,
  }),
];
