import { MCP_SCOPE } from '../constants/mcp-scopes';
import { InputRequiredResult } from '../protocol/mrtr';
import {
  McpToolContext,
  ToolDef,
  ToolResult,
  runTool,
  toolInputSchema,
} from './mcp-tool.util';
import { REPO_TOOLS } from './repo.tools';
import { McpApiError } from '../services/mcp-api.client';
import { isOfferedToGuest } from '../services/sandbox-tool-visibility';

const MAP = REPO_TOOLS.find((t) => t.name === 'repo_map')! as ToolDef;
const APPLY = REPO_TOOLS.find((t) => t.name === 'repo_map_apply')! as ToolDef;

const REPO_ID = '11111111-1111-1111-1111-111111111111';
const COMMIT = 'abc1234def5678901234567890123456789012ab';

/**
 * A map with the two shapes that matter: a fact that carries BOTH forms of its
 * citation (`source` and `evidence[]`), and a render that carries the same
 * manifest twice (`manifest` and `yaml`). What the compact view does to each is
 * the whole claim of this file.
 */
function mapResponse(over: { units?: string[] } = {}) {
  const unitIds = over.units ?? ['api', 'web'];
  const cite = (file: string) => ({
    source: `${file}:14`,
    evidence: [{ file, line: 14, excerpt: 'listen(3000)' }],
  });
  return {
    repositoryId: REPO_ID,
    repoFullName: 'acme/shop',
    branch: 'main',
    read: {
      ok: true,
      repoFullName: 'acme/shop',
      ref: 'main',
      commitSha: COMMIT,
      truncated: false,
      contentComplete: true,
      bytesRead: 4096,
      limits: { maxArchiveBytes: 1, timeoutMs: 1 },
    },
    map: {
      units: unitIds.map((id) => ({
        id,
        name: id,
        root: id,
        reason: 'has-dockerfile',
        build: { strategy: 'dockerfile' },
        port: { value: 3000, source: `${id}/main.ts:1` },
        healthPath: null,
        confidence: 'declared',
        env: [
          { name: 'PORT', role: 'literal', value: '3000', ...cite(`${id}/a`) },
          { name: 'DB_URL', role: 'secret', ...cite(`${id}/b`) },
          { name: 'DB_HOST', role: 'derived', ...cite(`${id}/c`) },
        ],
        ...cite(`${id}/Dockerfile`),
      })),
      services: [
        {
          name: 'db',
          block: 'postgresql',
          engine: 'postgres',
          family: 'sql',
          unit: 'api',
          confidence: 'derived',
          injectionKeys: ['DATABASE_URL'],
          signals: [{ kind: 'dependency', observed: 'pg' }],
          ...cite('api/package.json'),
        },
      ],
      inputs: [
        {
          name: 'STRIPE_SECRET_KEY',
          forService: null,
          unit: 'api',
          secret: true,
          blocksStart: true,
          reason:
            'read in api/billing.ts:22 with no default declared — fill it in before deploy.',
          ...cite('api/billing.ts'),
        },
        {
          name: 'SENTRY_DSN',
          forService: null,
          // Repository-wide: belongs to every unit, so narrowing must keep it.
          unit: null,
          secret: false,
          reason: 'read in shared/obs.ts:3',
          ...cite('shared/obs.ts'),
        },
        {
          name: 'NEXT_PUBLIC_API',
          forService: null,
          unit: 'web',
          secret: false,
          reason: 'read in web/env.ts:1',
          ...cite('web/env.ts'),
        },
      ],
      externals: [
        {
          name: 'stripe.com',
          requires: ['STRIPE_SECRET_KEY'],
          unit: 'api',
          confidence: 'circumstantial',
          ...cite('api/billing.ts'),
        },
      ],
      blockers: [],
      caveats: [
        {
          code: 'writes_to_local_disk',
          unit: 'api',
          summary: 'writes to ./uploads, which is not a volume',
          ...cite('api/upload.ts'),
        },
      ],
      questions: [
        {
          id: 'q1',
          question: 'Is web meant to be public?',
          options: ['public', 'internal'],
          ...cite('web/next.config.js'),
        },
      ],
      decisions: [
        {
          subject: 'port',
          choice: '3000',
          decidedBy: 'flui',
          confidence: 'derived',
          reason: 'the only port listened on',
          ...cite('api/main.ts'),
        },
      ],
      coverage: { filesRead: 20 },
      boundary: { searched: ['package.json'], notFound: ['go.mod'] },
    },
    verdict: {
      outcome: 'deployable_pending_inputs',
      reason: 'one input has no value yet.',
      remedy: 'Supply STRIPE_SECRET_KEY after the apply.',
      evidence: [{ file: 'api/billing.ts', line: 22 }],
      units: unitIds.map((id) => ({
        id,
        readiness: 'deployable_pending_inputs',
        reason: `${id} renders`,
        remedy: null,
        evidence: [{ file: `${id}/Dockerfile`, line: 1 }],
      })),
      capacity: {
        assessed: true,
        clusterId: 'c1',
        notAssessedReason: null,
        assessment: { known: true, fits: true },
        components: [],
        uncounted: ['db'],
      },
    },
    render: {
      units: unitIds.map((id) => ({
        unitId: id,
        name: id,
        yaml: `kind: Application\nmetadata:\n  name: ${id}\n`,
        manifest: { kind: 'Application', metadata: { name: id } },
      })),
      skipped: [{ unitId: 'worker', reason: 'no port could be read' }],
      notes: [],
    },
  };
}

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function ctxFor(
  over: {
    calls?: Recorded[];
    scopes?: Set<string>;
    repositories?: Array<{ id: string; repositoryFullName: string }>;
    clusters?: Array<{ id: string; name: string }>;
    reply?: unknown;
    fail?: McpApiError;
  } = {},
): McpToolContext {
  const calls = over.calls ?? [];
  const repositories = over.repositories ?? [
    { id: REPO_ID, repositoryFullName: 'acme/shop' },
  ];
  const clusters = over.clusters ?? [{ id: 'c1', name: 'one' }];
  return {
    user: { userId: 'u1', email: 'e@x' },
    scopes: over.scopes ?? new Set<string>(Object.values(MCP_SCOPE)),
    allowDestructive: true,
    surface: 'mcp',
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    api: {
      get: (path: string) => {
        calls.push({ method: 'GET', path });
        if (path === '/repositories') return Promise.resolve(repositories);
        if (path === '/infrastructure/clusters') {
          return Promise.resolve(clusters);
        }
        return Promise.resolve({});
      },
      post: (path: string, body: unknown) => {
        calls.push({ method: 'POST', path, body });
        if (over.fail) return Promise.reject(over.fail);
        return Promise.resolve(over.reply ?? mapResponse());
      },
    },
  } as unknown as McpToolContext;
}

const body = (result: ToolResult | InputRequiredResult) =>
  JSON.parse((result as ToolResult).content[0].text);

const text = (result: ToolResult | InputRequiredResult) =>
  (result as ToolResult).content[0].text;

const failed = (result: ToolResult | InputRequiredResult) =>
  (result as ToolResult).isError === true;

describe('repo_map — the facts, and what it is allowed to drop', () => {
  it('reads the map at the repository and the cluster it resolved', async () => {
    const calls: Recorded[] = [];
    await runTool(ctxFor({ calls }), MAP, { repository: 'acme/shop' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /repositories',
      'GET /infrastructure/clusters',
      `POST /repositories/${REPO_ID}/map?clusterId=c1`,
    ]);
  });

  it('carries the branch when one was named, and never invents one', async () => {
    const calls: Recorded[] = [];
    await runTool(ctxFor({ calls }), MAP, {
      repository: 'acme/shop',
      branch: 'feature/x',
    });
    expect(calls[2].path).toBe(
      `/repositories/${REPO_ID}/map?clusterId=c1&branch=feature%2Fx`,
    );
  });

  /**
   * The cluster is half of the verdict. Omitted quietly, a `deployable` that
   * was never weighed against a cluster would come back looking like one that
   * was — which is the one wrong answer a model cannot detect.
   */
  it('never asks for a map without a cluster to weigh it against', async () => {
    const result = await runTool(ctxFor({ clusters: [] }), MAP, {
      repository: 'acme/shop',
    });
    expect(failed(result)).toBe(true);
    expect(text(result)).toMatch(/No clusters exist yet/);
  });

  it('names the several clusters instead of picking one', async () => {
    const result = await runTool(
      ctxFor({
        clusters: [
          { id: 'c1', name: 'one' },
          { id: 'c2', name: 'two' },
        ],
      }),
      MAP,
      { repository: 'acme/shop' },
    );
    expect(failed(result)).toBe(true);
    expect(text(result)).toMatch(/pass clusterId/);
  });

  describe('the compact default', () => {
    const run = (args: Record<string, unknown> = {}) =>
      runTool(ctxFor(), MAP, { repository: 'acme/shop', ...args }).then(body);

    it('keeps every fact’s citation and firmness — the two things that make it checkable', async () => {
      const data = await run();
      expect(data.map.services[0].source).toBe('api/package.json:14');
      expect(data.map.services[0].confidence).toBe('derived');
      expect(data.map.inputs[0].source).toBe('api/billing.ts:14');
      expect(data.map.units[0].confidence).toBe('declared');
    });

    it('drops only the SECOND copy of that citation, never the citation', async () => {
      const data = await run();
      expect(data.map.services[0].evidence).toBeUndefined();
      expect(data.map.inputs[0].evidence).toBeUndefined();
      expect(data.map.units[0].evidence).toBeUndefined();
    });

    it('lists every required input by name, secret flag and blocking flag', async () => {
      const data = await run();
      expect(data.map.inputs.map((i: { name: string }) => i.name)).toEqual([
        'STRIPE_SECRET_KEY',
        'SENTRY_DSN',
        'NEXT_PUBLIC_API',
      ]);
      expect(data.map.inputs[0]).toMatchObject({
        secret: true,
        blocksStart: true,
      });
      // The prose is what costs; the fact is what matters.
      expect(data.map.inputs[0].reason).toBeUndefined();
    });

    it('summarises a unit’s env by role rather than listing it var by var', async () => {
      const data = await run();
      expect(data.map.units[0].env).toEqual({
        total: 3,
        counts: { literal: 1, secret: 1, derived: 1 },
        names: { literal: ['PORT'], secret: ['DB_URL'], derived: ['DB_HOST'] },
      });
    });

    it('keeps the yaml and drops the manifest — the same manifest twice', async () => {
      const data = await run();
      expect(data.render.units[0].yaml).toContain('kind: Application');
      expect(data.render.units[0].manifest).toBeUndefined();
      expect(data.render.skipped).toHaveLength(1);
    });

    it('keeps the verdict, its taxonomy and its capacity whole', async () => {
      const data = await run();
      expect(data.verdict.outcome).toBe('deployable_pending_inputs');
      expect(data.verdict.remedy).toContain('STRIPE_SECRET_KEY');
      expect(data.verdict.capacity.uncounted).toEqual(['db']);
      expect(data.verdict.units[0]).toMatchObject({
        id: 'api',
        readiness: 'deployable_pending_inputs',
      });
    });

    it('keeps caveats and open questions WITH their evidence — nobody decided those', async () => {
      const data = await run();
      expect(data.map.caveats[0].evidence).toHaveLength(1);
      expect(data.map.questions[0].evidence).toHaveLength(1);
      expect(data.map.questions[0].options).toEqual(['public', 'internal']);
    });

    it('keeps the read boundary whole, so “not found” and “not looked at” stay apart', async () => {
      const data = await run();
      expect(data.read.commitSha).toBe(COMMIT);
      expect(data.read.limits).toBeDefined();
      expect(data.note).toContain(COMMIT);
    });

    it('says what it left out and how to ask for it', async () => {
      const data = await run();
      expect(data.note).toContain("detail:'evidence'");
      expect(data.note).toContain("detail:'full'");
    });

    it('warns when the repository was not read to the end', async () => {
      const truncated = mapResponse();
      truncated.read.truncated = true;
      truncated.read.contentComplete = false;
      const data = body(
        await runTool(ctxFor({ reply: truncated }), MAP, {
          repository: 'acme/shop',
        }),
      );
      expect(data.note).toMatch(/NOT read to the end/);
    });
  });

  describe('the way out of the compaction', () => {
    it('gives the evidence and the reasons back at detail:"evidence"', async () => {
      const data = body(
        await runTool(ctxFor(), MAP, {
          repository: 'acme/shop',
          detail: 'evidence',
        }),
      );
      expect(data.map.inputs[0].reason).toContain('api/billing.ts:22');
      expect(data.map.inputs[0].evidence).toHaveLength(1);
      expect(data.map.services[0].signals).toHaveLength(1);
      expect(data.map.decisions).toHaveLength(1);
      expect(data.map.boundary.notFound).toEqual(['go.mod']);
    });

    it('hands back the response untouched at detail:"full"', async () => {
      const data = body(
        await runTool(ctxFor(), MAP, {
          repository: 'acme/shop',
          detail: 'full',
        }),
      );
      expect(data).toEqual(mapResponse());
    });

    /**
     * At the schema, which is where the MCP server validates: a
     * plausible-but-unpublished level is rejected by name rather than
     * silently treated as the default, so the agent learns the three that
     * exist instead of believing it got a fourth.
     */
    it('refuses a detail level it does not publish, instead of guessing', () => {
      const schema = toolInputSchema(MAP.inputSchema);
      const rejected = schema.safeParse({
        repository: 'acme/shop',
        detail: 'summary',
      });
      expect(rejected.success).toBe(false);
      expect(
        schema.safeParse({ repository: 'acme/shop', detail: 'evidence' })
          .success,
      ).toBe(true);
    });
  });

  describe('one unit at a time, which is what makes a monorepo readable', () => {
    it('narrows every list to the named unit', async () => {
      const data = body(
        await runTool(ctxFor(), MAP, {
          repository: 'acme/shop',
          unitId: 'api',
        }),
      );
      expect(data.map.units.map((u: { id: string }) => u.id)).toEqual(['api']);
      expect(data.verdict.units.map((u: { id: string }) => u.id)).toEqual([
        'api',
      ]);
      expect(
        data.render.units.map((u: { unitId: string }) => u.unitId),
      ).toEqual(['api']);
      expect(data.map.services).toHaveLength(1);
    });

    /**
     * An input scoped to the whole repository belongs to every unit. Filtering
     * it out would answer "this unit needs nothing else" about a variable that
     * still blocks its start.
     */
    it('keeps what is scoped to the repository as a whole', async () => {
      const data = body(
        await runTool(ctxFor(), MAP, {
          repository: 'acme/shop',
          unitId: 'api',
        }),
      );
      expect(data.map.inputs.map((i: { name: string }) => i.name)).toEqual([
        'STRIPE_SECRET_KEY',
        'SENTRY_DSN',
      ]);
      expect(data.note).toContain('unit: null');
    });

    it('refuses an unknown unit by naming the real ones, rather than answering empty', async () => {
      const result = await runTool(ctxFor(), MAP, {
        repository: 'acme/shop',
        unitId: 'worker',
      });
      expect(failed(result)).toBe(true);
      expect(text(result)).toContain('api, web');
    });
  });
});

describe('finding the repository the way a model can name it', () => {
  it('accepts owner/repo', async () => {
    const calls: Recorded[] = [];
    await runTool(ctxFor({ calls }), MAP, { repository: 'acme/shop' });
    expect(calls[2].path).toContain(`/repositories/${REPO_ID}/map`);
  });

  it('accepts a GitHub URL', async () => {
    const calls: Recorded[] = [];
    await runTool(ctxFor({ calls }), MAP, {
      repository: 'https://github.com/acme/shop.git',
    });
    expect(calls[2].path).toContain(`/repositories/${REPO_ID}/map`);
  });

  it('passes an id straight through, with no listing round trip', async () => {
    const calls: Recorded[] = [];
    await runTool(ctxFor({ calls }), MAP, { repository: REPO_ID });
    expect(calls.map((c) => c.path)).not.toContain('/repositories');
  });

  it('says a repository is not CONNECTED, and which ones are', async () => {
    const result = await runTool(ctxFor(), MAP, { repository: 'acme/other' });
    expect(failed(result)).toBe(true);
    expect(text(result)).toContain('repo_connect');
    expect(text(result)).toContain('acme/shop');
  });

  it('says so plainly when nothing at all is connected', async () => {
    const result = await runTool(ctxFor({ repositories: [] }), MAP, {
      repository: 'acme/shop',
    });
    expect(text(result)).toContain('No repositories are connected at all');
  });
});

describe('repo_map_apply — the write', () => {
  const applyReply = {
    repositoryId: REPO_ID,
    repoFullName: 'acme/shop',
    baseBranch: 'main',
    baseCommitSha: COMMIT,
    branch: 'flui/deploy-abc1234',
    branchUrl: 'https://github.com/acme/shop/tree/flui/deploy-abc1234',
    commitSha: 'ffff111',
    commitUrl: 'https://github.com/acme/shop/commit/ffff111',
    files: ['api/flui.yaml', '.github/workflows/flui-api.yml'],
    units: [
      {
        unitId: 'api',
        name: 'api',
        applicationId: 'app-1',
        slug: 'api-ab12cd',
        manifestPath: 'api/flui.yaml',
        workflowPath: '.github/workflows/flui-api.yml',
        status: 'AWAITING_BUILD',
        armed: true,
        pendingInputs: ['STRIPE_SECRET_KEY'],
      },
    ],
    partial: false,
    skipped: [],
    verdict: 'deployable_pending_inputs',
    verdictReason: 'one input has no value yet.',
  };

  it('posts the cluster it resolved, and nothing the caller could smuggle in', async () => {
    const calls: Recorded[] = [];
    await runTool(ctxFor({ calls, reply: applyReply }), APPLY, {
      repository: 'acme/shop',
      branch: 'main',
      unitIds: ['api'],
    });
    const post = calls[calls.length - 1];
    expect(post.path).toBe(`/repositories/${REPO_ID}/map/apply`);
    expect(post.body).toEqual({
      clusterId: 'c1',
      branch: 'main',
      unitIds: ['api'],
    });
  });

  it('reports the branch, the commit and each unit’s application', async () => {
    const data = body(
      await runTool(ctxFor({ reply: applyReply }), APPLY, {
        repository: 'acme/shop',
      }),
    );
    expect(data.branch).toBe('flui/deploy-abc1234');
    expect(data.baseCommitSha).toBe(COMMIT);
    expect(data.units[0].applicationId).toBe('app-1');
    expect(data.files).toEqual({ count: 2, paths: applyReply.files });
  });

  /**
   * The keys, and where the value is allowed to come from. A tool that took
   * values here would be a fourth way to write env and — worse — would put a
   * secret through the agent, which `app_variable_set` refuses to do.
   */
  it('names the variables still owed and sends the agent to ask a person', async () => {
    const data = body(
      await runTool(ctxFor({ reply: applyReply }), APPLY, {
        repository: 'acme/shop',
      }),
    );
    expect(data.units[0].pendingInputs).toEqual(['STRIPE_SECRET_KEY']);
    expect(data.note).toContain('app_variable_request');
    expect(data.note).toContain('STRIPE_SECRET_KEY');
  });

  it('accepts no value for a variable, at the schema', () => {
    expect(Object.keys(APPLY.inputSchema).sort()).toEqual([
      'branch',
      'clusterId',
      'repository',
      'unitIds',
    ]);
  });

  it('tells the agent NOT to repeat a partial apply', async () => {
    const partial = {
      ...applyReply,
      partial: true,
      units: [
        { ...applyReply.units[0], armed: false, reason: 'token expired' },
      ],
    };
    const data = body(
      await runTool(ctxFor({ reply: partial }), APPLY, {
        repository: 'acme/shop',
      }),
    );
    expect(data.note).toContain('PARTIAL');
    expect(data.note).toMatch(/Do NOT repeat this call/);
  });

  it('relays a verdict refusal as the error it is, without inviting a retry', async () => {
    const result = await runTool(
      ctxFor({
        fail: new McpApiError(
          422,
          'Flui will not apply a map whose verdict is `blocked`.',
          'POST',
          `/repositories/${REPO_ID}/map/apply`,
        ),
      }),
      APPLY,
      { repository: 'acme/shop' },
    );
    expect(failed(result)).toBe(true);
    expect(text(result)).toContain('verdict is `blocked`');
    expect(text(result)).toMatch(/same arguments will fail the same way/);
  });

  it('relays "no write access" as a settled refusal, not as a scope problem', async () => {
    const result = await runTool(
      ctxFor({
        fail: new McpApiError(
          403,
          'No write access to the repository',
          'POST',
          `/repositories/${REPO_ID}/map/apply`,
        ),
      }),
      APPLY,
      { repository: 'acme/shop' },
    );
    expect(failed(result)).toBe(true);
    expect(text(result)).toMatch(/NOT a scope problem/);
  });

  /**
   * The action cycle asking a person is a WAIT. Rendered as an error an agent
   * retries blindly or gives up, and here neither is right.
   */
  it('turns the cycle’s question into input_required, never into a failure', async () => {
    const result = await runTool(
      ctxFor({
        fail: new McpApiError(
          403,
          'waiting',
          'POST',
          `/repositories/${REPO_ID}/map/apply`,
          undefined,
          undefined,
          {
            proposalId: 'p1',
            action: 'POST /repositories/:id/map/apply',
            sentence:
              'commit Flui-rendered manifests to repository r1 and start their builds',
            offersAlways: true,
            estimateWithheld: false,
            decideUrl: '/requests/p1',
          },
        ),
      }),
      APPLY,
      { repository: 'acme/shop' },
    );
    expect((result as ToolResult).isError).toBeUndefined();
    const asked = (result as InputRequiredResult).inputRequests
      ?.approved as unknown as { params: { message: string } };
    expect(asked.params.message).toContain('commit Flui-rendered manifests');
  });
});

describe('who is offered these at all', () => {
  it('refuses the read to a principal that was never granted the scope', async () => {
    const result = await runTool(ctxFor({ scopes: new Set<string>() }), MAP, {
      repository: 'acme/shop',
    });
    expect(failed(result)).toBe(true);
    expect(text(result)).toMatch(/GRANT problem/);
  });

  it('refuses the write to a read-only agent credential', async () => {
    const result = await runTool(
      ctxFor({ scopes: new Set<string>([MCP_SCOPE.APP_READ]) }),
      APPLY,
      { repository: 'acme/shop' },
    );
    expect(failed(result)).toBe(true);
    expect(text(result)).toContain(MCP_SCOPE.APP_WRITE);
  });

  /**
   * A sandbox guest is a stranger to the repository owner, and every
   * `/repositories` route is closed to one — so neither tool is even offered.
   * Read off the fence, not written twice.
   */
  it('offers neither to a sandbox guest', () => {
    expect(isOfferedToGuest(MAP)).toBe(false);
    expect(isOfferedToGuest(APPLY)).toBe(false);
  });

  it('publishes the read at app:read and the write at app:write', () => {
    expect(MAP.scope).toBe(MCP_SCOPE.APP_READ);
    expect(APPLY.scope).toBe(MCP_SCOPE.APP_WRITE);
  });
});

/**
 * The descriptions are what an agent chooses on. `repo_map` is one road to a
 * deploy and the others must not read as fallbacks — an agent that believed
 * this were the sanctioned path would drag a repository through a mapping it
 * did not need.
 */
describe('what the descriptions promise', () => {
  it('names the equal alternatives, in both tools', () => {
    for (const tool of [MAP, APPLY]) {
      expect(tool.description).toContain('app_deploy_from_yaml');
      expect(tool.description).toContain('app_deploy_image');
    }
  });

  it('says out loud that the read writes nothing and the apply writes', () => {
    expect(MAP.description).toContain('READ-ONLY');
    expect(APPLY.description).toContain('WRITES to a real GitHub repository');
  });

  it('tells the agent what an input_required answer means and what to do', () => {
    expect(APPLY.description).toContain('input_required');
    expect(APPLY.description).toMatch(/IDENTICAL call/);
  });
});
