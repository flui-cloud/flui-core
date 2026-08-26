import { SELF_SERVICE_TOOLS } from './self-service.tools';
import { McpToolContext, ToolDef, runTool } from './mcp-tool.util';
import { McpApiCaller, McpApiError } from '../services/mcp-api.client';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { isOfferedToGuest } from '../services/sandbox-tool-visibility';

interface Call {
  method: string;
  path: string;
  body?: unknown;
  query?: unknown;
}

type Reply = unknown | ((call: Call) => unknown);

const find = (name: string): ToolDef => {
  const tool = SELF_SERVICE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

/**
 * A stand-in API that answers by path. Anything unmatched answers `{}` — a tool
 * that reaches somewhere the test did not describe should still run to the end,
 * so a missing reply shows up as a wrong assertion rather than a crash that
 * could be mistaken for the behaviour under test.
 */
function ctxWith(
  replies: Record<string, Reply>,
  calls: Call[] = [],
  over: Partial<McpToolContext> = {},
): McpToolContext {
  const answer = (call: Call): Promise<never> => {
    calls.push(call);
    const key = `${call.method} ${call.path.split('?')[0]}`;
    const reply = replies[key];
    if (reply instanceof Error) return Promise.reject(reply) as Promise<never>;
    const value = typeof reply === 'function' ? reply(call) : reply;
    return Promise.resolve(value ?? {}) as Promise<never>;
  };
  const api: McpApiCaller = {
    get: (path, query) => answer({ method: 'GET', path, query }),
    post: (path, body) => answer({ method: 'POST', path, body }),
    put: (path, body) => answer({ method: 'PUT', path, body }),
    patch: (path, body) => answer({ method: 'PATCH', path, body }),
    delete: (path) => answer({ method: 'DELETE', path }),
  };
  return {
    user: { userId: 'u1', email: 'guest@flui.cloud' },
    scopes: new Set<string>(Object.values(MCP_SCOPE)),
    allowDestructive: false,
    surface: 'mcp',
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    api,
    ...over,
  } as unknown as McpToolContext;
}

async function call(
  name: string,
  args: unknown,
  replies: Record<string, Reply> = {},
  calls: Call[] = [],
  over: Partial<McpToolContext> = {},
): Promise<{ ok: boolean; text: string; data: Record<string, unknown> }> {
  const result = await runTool(ctxWith(replies, calls, over), find(name), args);
  const text =
    (result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '';
  const isError = !!(result as { isError?: boolean }).isError;
  return {
    ok: !isError,
    text,
    data: isError ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const notFound = (path: string) =>
  new McpApiError(404, 'nope', 'GET', path) as unknown as Reply;

/**
 * The claim the whole batch rests on: the routes were already open to a guest,
 * so not one fence rule was written for any of this. If a later change closes
 * one of them, the tool that depends on it stops being offered — and the demo
 * loses the half of it that makes a trial credible — silently. This is what
 * says so out loud.
 */
describe('the guest is offered every one of these', () => {
  it.each(SELF_SERVICE_TOOLS.map((t) => t.name))(
    '%s reaches a route the fence already opens, with no rule of its own',
    (name) => {
      expect(isOfferedToGuest(find(name))).toBe(true);
    },
  );
});

describe('putting an application back', () => {
  const revisions = [
    { revisionNumber: 5, imageRef: 'app:5', status: 'failed' },
    { revisionNumber: 4, imageRef: 'app:4', status: 'running' },
    { revisionNumber: 3, imageRef: 'app:3', status: 'running' },
  ];

  it('undoes the last deploy without being told which revision, and names the one it picked', async () => {
    const calls: Call[] = [];
    const { data } = await call(
      'app_rollback',
      { id: 'a1' },
      {
        'GET /applications/a1/revisions': revisions,
        'POST /applications/a1/rollback': { id: 'op1', status: 'PENDING' },
      },
      calls,
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ revisionNumber: 4 });
    expect(data.rollingBackTo).toContain('#4');
    // Named in the answer, because the model did not choose it: a rollback
    // reported without its target is one nobody can disagree with.
    expect(data.chosenBy).toBeDefined();
  });

  /**
   * The failed revision at the top is the one a naive "take the second entry"
   * would have skipped past correctly by luck; the one below it is where that
   * rule breaks. This pins the rule that is actually written: highest below the
   * current, that did not fail.
   */
  it('never lands on a revision that failed', async () => {
    const calls: Call[] = [];
    await call(
      'app_rollback',
      { id: 'a1' },
      {
        'GET /applications/a1/revisions': [
          { revisionNumber: 5, status: 'running' },
          { revisionNumber: 4, status: 'failed' },
          { revisionNumber: 3, status: 'running' },
        ],
        'POST /applications/a1/rollback': { id: 'op1', status: 'PENDING' },
      },
      calls,
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      revisionNumber: 3,
    });
  });

  it('takes an explicit revision without reading the history at all', async () => {
    const calls: Call[] = [];
    await call(
      'app_rollback',
      { id: 'a1', revisionNumber: 2, reason: 'bad release' },
      { 'POST /applications/a1/rollback': { id: 'op1', status: 'PENDING' } },
      calls,
    );
    expect(calls.map((c) => c.path)).toEqual(['/applications/a1/rollback']);
    expect(calls[0].body).toMatchObject({
      revisionNumber: 2,
      reason: 'bad release',
    });
  });

  it('refuses with the history in the message when there is nowhere to go back to', async () => {
    const { ok, text } = await call(
      'app_rollback',
      { id: 'a1' },
      {
        'GET /applications/a1/revisions': [
          { revisionNumber: 1, imageRef: 'app:1', status: 'running' },
        ],
      },
    );
    expect(ok).toBe(false);
    expect(text).toContain('#1');
    expect(text).toContain('Deploy a known-good image');
  });

  it('says plainly that a never-deployed application has no earlier state', async () => {
    const { ok, text } = await call(
      'app_rollback',
      { id: 'a1' },
      { 'GET /applications/a1/revisions': [] },
    );
    expect(ok).toBe(false);
    expect(text).toContain('no recorded revisions');
  });

  it('tells an MCP client to follow the operation itself', async () => {
    const { data } = await call(
      'app_rollback',
      { id: 'a1', revisionNumber: 2 },
      { 'POST /applications/a1/rollback': { id: 'op1', status: 'PENDING' } },
    );
    expect(data.operationId).toBe('op1');
    expect(data.done).toBe(false);
    expect(String(data.note)).toContain('operation_status');
  });
});

describe('changing CPU and memory', () => {
  it('corrects a quantity the model spelled the human way, before any call', async () => {
    const calls: Call[] = [];
    const { ok, text } = await call(
      'app_set_resources',
      { id: 'a1', limits: { memory: '512MB' } },
      {},
      calls,
    );
    expect(ok).toBe(false);
    expect(text).toContain('256Mi');
    expect(calls).toEqual([]);
  });

  it('rejects "0.5 CPU" and names the two accepted spellings', async () => {
    const { ok, text } = await call('app_set_resources', {
      id: 'a1',
      requests: { cpu: '0.5 CPU' },
    });
    expect(ok).toBe(false);
    expect(text).toContain('500m');
  });

  it('accepts cores, millicores and every memory suffix Kubernetes takes', async () => {
    const calls: Call[] = [];
    await call(
      'app_set_resources',
      {
        id: 'a1',
        requests: { cpu: '250m', memory: '256Mi' },
        limits: { cpu: '2', memory: '1Gi' },
      },
      {},
      calls,
    );
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/applications/a1/resources',
    });
  });

  it('refuses a call that would change nothing rather than patching with nothing', async () => {
    const calls: Call[] = [];
    const { ok, text } = await call(
      'app_set_resources',
      { id: 'a1' },
      {},
      calls,
    );
    expect(ok).toBe(false);
    expect(text).toContain('app_status');
    expect(calls).toEqual([]);
  });

  it('warns that the usage it shows belongs to the pods being replaced', async () => {
    const { data } = await call(
      'app_set_resources',
      { id: 'a1', limits: { memory: '1Gi' } },
      {
        'PATCH /applications/a1/resources': {
          deploymentName: 'my-api',
          replicas: { desired: 2, ready: 2 },
          containers: [{ name: 'app', limits: { memory: '512Mi' } }],
        },
      },
    );
    expect(data.app).toBe('my-api');
    expect(String(data.note)).toContain('OLD pods');
  });
});

describe('reconciling', () => {
  const summary = (over: Record<string, unknown>) => ({
    'POST /applications/a1/reconcile': {
      applicationName: 'my-api',
      previousStatus: 'running',
      newStatus: 'running',
      driftedResources: [],
      healedResources: [],
      errors: [],
      ...over,
    },
  });

  it('reports a clean application as agreeing with the record', async () => {
    const { data } = await call('app_reconcile', { id: 'a1' }, summary({}));
    expect(String(data.note)).toContain('No drift');
  });

  /**
   * The answer that reads as a success and is not one. Drift found with nothing
   * healed means this application does not heal itself — a model that relays
   * "reconciled" here tells the person the opposite of what happened.
   */
  it('does not let "drift found, nothing healed" read as a repair', async () => {
    const { data } = await call(
      'app_reconcile',
      { id: 'a1' },
      summary({ driftedResources: ['Deployment/my-api'] }),
    );
    expect(String(data.note)).toContain('NOT corrected');
    expect(data.drifted).toEqual(['Deployment/my-api']);
  });

  it('says so when the drift was put back', async () => {
    const { data } = await call(
      'app_reconcile',
      { id: 'a1' },
      summary({
        driftedResources: ['Deployment/my-api'],
        healedResources: ['Deployment/my-api'],
      }),
    );
    expect(String(data.note)).toContain('put back');
  });
});

describe('metrics', () => {
  const path = 'GET /observability/applications/a1/metrics';

  /**
   * The failure this projection exists for: Prometheus silent, every field
   * null, and a model reporting an idle, healthy application.
   */
  it('says nothing was measured rather than answering zero', async () => {
    const { data } = await call(
      'app_metrics',
      { id: 'a1' },
      {
        [path]: {
          app_name: 'my-api',
          metrics: {
            cpu: { usage_cores: null },
            memory: { usage_bytes: null },
            status: { replicas_ready: null },
          },
        },
      },
    );
    expect(data.measured).toBe(false);
    expect(String(data.note)).toContain('UNMEASURED');
    expect(String(data.note)).toContain('app_status');
  });

  it('carries the disk figure nothing else reports', async () => {
    const { data } = await call(
      'app_metrics',
      { id: 'a1' },
      {
        [path]: {
          app_name: 'my-api',
          metrics: {
            cpu: { usage_cores: 0.2, limits_cores: 1, utilization_percent: 20 },
            memory: { usage_bytes: 100, utilization_percent: 40 },
            status: { replicas_desired: 2, replicas_ready: 2 },
            volume: {
              used_bytes: 9,
              capacity_bytes: 10,
              utilization_percent: 90,
              alert_level: 'warning',
            },
            pods: [{ phase: 'Running', count: 2 }],
          },
        },
      },
    );
    expect(data.measured).toBe(true);
    expect(data.disk).toMatchObject({ percentFull: 90, alert: 'warning' });
    expect(data.pods).toEqual(['Running: 2']);
  });

  it('asks the history route with a real range when told to look back', async () => {
    const calls: Call[] = [];
    await call(
      'app_metrics',
      { id: 'a1', sinceMinutes: 60, step: '5m' },
      {
        'GET /observability/applications/a1/metrics/history': {
          data_points: [{ timestamp: 1 }],
        },
      },
      calls,
    );
    expect(calls[0].path).toBe(
      '/observability/applications/a1/metrics/history',
    );
    const query = calls[0].query as {
      start: string;
      end: string;
      step: string;
    };
    expect(query.step).toBe('5m');
    expect(Date.parse(query.end) - Date.parse(query.start)).toBe(3_600_000);
  });

  /**
   * The instant projection would read a series as "unmeasured", because none of
   * the fields it looks at exist on it. Passing the range answer through whole
   * is what stops a healthy application being reported as unmeasured.
   */
  it('passes a time series through instead of projecting it into "unmeasured"', async () => {
    const { data } = await call(
      'app_metrics',
      { id: 'a1', sinceMinutes: 30 },
      {
        'GET /observability/applications/a1/metrics/history': {
          data_points: [{ timestamp: 1, cpu_usage_cores: 0.3 }],
        },
      },
    );
    expect(data.measured).toBeUndefined();
    expect(data.data_points).toHaveLength(1);
  });
});

describe('reading variables', () => {
  it('never hands the mask back as if it were a value', async () => {
    const { data } = await call(
      'app_variables',
      { applicationId: 'a1' },
      {
        'GET /variables/applications/a1': {
          name: 'my-api',
          data: { LOG_LEVEL: 'debug', DB_PASSWORD: '****' },
          sensitiveKeys: ['DB_PASSWORD'],
          pendingKeys: ['STRIPE_SECRET_KEY'],
        },
      },
    );
    expect(data.plain).toEqual({ LOG_LEVEL: 'debug' });
    expect(data.sensitiveKeys).toEqual(['DB_PASSWORD']);
    expect(data.awaitingAValue).toEqual(['STRIPE_SECRET_KEY']);
    expect(JSON.stringify(data.plain)).not.toContain('****');
  });
});

describe('writing a plain variable', () => {
  const empty = {
    'GET /variables/applications/a1': {
      name: 'my-api',
      data: {},
      sensitiveKeys: [],
      pendingKeys: [],
    },
  };

  it('writes ordinary configuration through the plain half of the route', async () => {
    const calls: Call[] = [];
    await call(
      'app_variable_set',
      { applicationId: 'a1', variables: { LOG_LEVEL: 'debug', PORT: '8080' } },
      empty,
      calls,
    );
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/variables/applications/a1?type=plain');
    expect(put.body).toEqual({ data: { LOG_LEVEL: 'debug', PORT: '8080' } });
  });

  /**
   * The check that rests on evidence rather than on the look of a name: this
   * key is called nothing in particular, and the product already knows a person
   * delivered a secret into it.
   */
  it('refuses a key the application already holds as sensitive', async () => {
    const calls: Call[] = [];
    const { ok, text } = await call(
      'app_variable_set',
      { applicationId: 'a1', variables: { CONNECTION: 'postgres://x' } },
      {
        'GET /variables/applications/a1': {
          data: {},
          sensitiveKeys: ['CONNECTION'],
          pendingKeys: [],
        },
      },
      calls,
    );
    expect(ok).toBe(false);
    expect(text).toContain('SENSITIVE');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses a key still awaiting its value, rather than filling it in the clear', async () => {
    const { ok, text } = await call(
      'app_variable_set',
      { applicationId: 'a1', variables: { STRIPE_SECRET: 'sk' } },
      {
        'GET /variables/applications/a1': {
          data: {},
          sensitiveKeys: [],
          pendingKeys: ['STRIPE_SECRET'],
        },
      },
    );
    expect(ok).toBe(false);
    expect(text).toContain('app_variable_request');
  });

  it('refuses a name that says credential', async () => {
    const { ok, text } = await call(
      'app_variable_set',
      { applicationId: 'a1', variables: { DB_PASSWORD: 'hunter2' } },
      empty,
    );
    expect(ok).toBe(false);
    expect(text).toContain('ConfigMap');
  });

  /**
   * The check a name test cannot make. By the time this runs the value has
   * already been in the model's context, so the refusal says to rotate it —
   * refusing to store it does not un-say it.
   */
  it('refuses a credential-shaped value under an innocent name, and says to rotate it', async () => {
    const { ok, text } = await call(
      'app_variable_set',
      { applicationId: 'a1', variables: { GREETING: 'ghp_abcdefghijklmnop' } },
      empty,
    );
    expect(ok).toBe(false);
    expect(text).toContain('rotate');
  });

  it('leaves ordinary names that merely contain a scary word alone', async () => {
    const calls: Call[] = [];
    const { ok } = await call(
      'app_variable_set',
      {
        applicationId: 'a1',
        variables: { NEXTAUTH_URL: 'https://x.test', AUTH_ENABLED: 'true' },
      },
      empty,
      calls,
    );
    expect(ok).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  /**
   * All or nothing. A partial write leaves the caller unsure which keys landed,
   * and an agent that is unsure writes them all again.
   */
  it('writes not one key when one of several is refused', async () => {
    const calls: Call[] = [];
    const { ok, text } = await call(
      'app_variable_set',
      {
        applicationId: 'a1',
        variables: { LOG_LEVEL: 'debug', API_KEY: 'abc' },
      },
      empty,
      calls,
    );
    expect(ok).toBe(false);
    expect(text).toContain('not one of the 2 keys');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses an empty write instead of calling the route with nothing', async () => {
    const calls: Call[] = [];
    const { ok } = await call(
      'app_variable_set',
      { applicationId: 'a1', variables: {} },
      empty,
      calls,
    );
    expect(ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('knowing your own edge', () => {
  const paid = {
    'GET /me/permissions': { permissions: ['app:read', 'app:write'] },
    'GET /me/sections': {
      sections: ['workloads', 'observability'],
      readOnlySections: ['observability'],
    },
    'GET /sandbox/session': notFound('/sandbox/session'),
  };

  it('says there is no trial, and does not go looking for its limits', async () => {
    const calls: Call[] = [];
    const { data } = await call('my_permissions', {}, paid, calls);
    expect(String(data.trial)).toContain('not in a trial');
    expect(calls.map((c) => c.path)).not.toContain('/sandbox/limits');
  });

  it('reports the sections and which of them are read-only', async () => {
    const { data } = await call('my_permissions', {}, paid);
    expect(data.sections).toEqual({
      open: ['workloads', 'observability'],
      readOnly: ['observability'],
    });
    expect(data.permissions).toEqual(['app:read', 'app:write']);
  });

  /**
   * The distinction the whole tool is for: a scope hides a tool for every
   * resource, a permission refuses one resource. An agent that cannot tell them
   * apart tells the person the wrong thing about both.
   */
  it('reports the credential’s own ceiling, read off the request rather than fetched', async () => {
    const calls: Call[] = [];
    const { data } = await call('my_permissions', {}, paid, calls, {
      scopes: new Set([MCP_SCOPE.APP_READ]),
      allowDestructive: false,
    });
    const credential = data.yourAgentCredential as Record<string, unknown>;
    expect(credential.toolScopes).toEqual([MCP_SCOPE.APP_READ]);
    expect(credential.destructiveToolsEnabled).toBe(false);
    expect(String(credential.note)).toContain('grant problem');
    expect(calls.map((c) => c.path)).not.toContain('/auth/api-keys');
  });

  it('turns a trial area into a sentence a person can be told', async () => {
    const { data } = await call(
      'my_permissions',
      {},
      {
        ...paid,
        'GET /sandbox/session': {
          expiresAt: '2026-08-26T00:00:00.000Z',
          secondsRemaining: 7200,
        },
        'GET /sandbox/limits': {
          quota: { cpu: '2 cores', pods: 12 },
          areas: [
            {
              key: 'workloads',
              area: 'Your applications',
              level: 'full',
              why: 'Yours.',
            },
            {
              key: 'providers',
              area: 'Cloud providers',
              level: 'stand-in',
              why: 'They belong to the instance you are borrowing.',
            },
          ],
        },
      },
    );
    const trial = data.trial as Record<string, unknown>;
    expect(trial.hoursLeft).toBe(2);
    expect(trial.quota).toMatchObject({ pods: 12 });
    const areas = trial.areas as Array<Record<string, string>>;
    expect(areas[1].means).toContain('NOT real');
    // The sentence that separates "not in the trial" from "Flui cannot".
    expect(String(trial.note)).toContain('not of Flui');
  });

  it('reports the trial as absent when the instance has no sandbox at all', async () => {
    const { data } = await call(
      'my_permissions',
      {},
      {
        ...paid,
        'GET /sandbox/session': notFound('/sandbox/session'),
      },
    );
    expect(typeof data.trial).toBe('string');
  });

  /** A refusal that is not an absence must not be swallowed into "no trial". */
  it('lets a real failure of the session route surface', async () => {
    const { ok } = await call(
      'my_permissions',
      {},
      {
        ...paid,
        'GET /sandbox/session': new McpApiError(
          500,
          'boom',
          'GET',
          '/sandbox/session',
        ) as unknown as Reply,
      },
    );
    expect(ok).toBe(false);
  });
});
