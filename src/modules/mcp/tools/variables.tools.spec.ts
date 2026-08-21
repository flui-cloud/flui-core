import type { ServerContext } from '@modelcontextprotocol/server';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { InputRequiredResult } from '../protocol/mrtr';
import { McpToolContext, ToolDef, ToolResult, runTool } from './mcp-tool.util';
import { VARIABLE_TOOLS } from './variables.tools';

const TOOL = VARIABLE_TOOLS.find((t) => t.name === 'app_variable_request')!;
const SECRET = 'sk_live_do_not_leak_me';

interface Fake {
  ctx: McpToolContext;
  requested: string[][];
  configured: Set<string>;
  pending: Set<string>;
  skip?: { name: string; reason: string };
}

function fake(over: Partial<Fake> = {}): Fake {
  const configured = over.configured ?? new Set<string>();
  const pending = over.pending ?? new Set<string>();
  const requested: string[][] = [];
  const state: Fake = {
    configured,
    pending,
    requested,
    skip: over.skip,
    ctx: {
      user: { userId: 'u1', email: 'e@x' },
      scopes: new Set<string>(Object.values(MCP_SCOPE)),
      allowDestructive: false,
      surface: 'mcp',
      audit: { record: jest.fn() },
      services: {
        apps: { findById: async () => ({ id: 'app-1', slug: 'my-api' }) },
        appConfig: {
          getAppVariablesCombined: async () => ({
            sensitiveKeys: [...configured],
            pendingKeys: [...pending],
          }),
          requestAppSecrets: async (_id: string, keys: string[]) => {
            requested.push(keys);
            if (over.skip) return { requested: [], skipped: [over.skip] };
            for (const key of keys) pending.add(key);
            return { requested: keys, skipped: [] };
          },
        },
      },
    } as unknown as McpToolContext,
  };
  return state;
}

/**
 * The round as the 2026-07-28 SDK hands it to a handler: `inputResponses` and
 * `requestState` lifted out of the `tools/call` params onto the request
 * context. Section 3 had to smuggle them through `_meta` because the v1 codec
 * stripped the spec position; section 7 put them back where the spec puts them.
 */
const round = (over: {
  inputResponses?: Record<string, unknown>;
  requestState?: string;
}): ServerContext =>
  ({
    mcpReq: {
      inputResponses: over.inputResponses,
      requestState: () => over.requestState,
    },
  }) as unknown as ServerContext;

const call = (f: Fake, args: Record<string, unknown>, sdkCtx?: ServerContext) =>
  runTool(f.ctx, TOOL as ToolDef, { applicationId: 'app-1', ...args }, sdkCtx);

/** The JSON body of a completed tool result. */
const body = (result: ToolResult | InputRequiredResult) =>
  JSON.parse((result as ToolResult).content[0].text);

const text = (result: ToolResult | InputRequiredResult) =>
  (result as ToolResult).content[0].text;

const asked = (result: ToolResult | InputRequiredResult) =>
  (result as InputRequiredResult).inputRequests?.delivered as unknown as {
    params: {
      message: string;
      requestedSchema: { properties: Record<string, unknown> };
    };
  };

/**
 * The hand-off as an agent sees it.
 *
 * Every case here defends one of the three rules: the value is never in the
 * call, it is never read back, and a missing value is a state rather than a
 * failure — because an agent that reads a failure retries, and a retry on a
 * half-finished mutation is how a retry becomes damage.
 */
describe('app_variable_request', () => {
  it('asks instead of failing when the value is not there yet', async () => {
    const f = fake();
    const result = await call(f, { key: 'STRIPE_SECRET_KEY' });

    // No `content`, and no `isError`: the 2026-07-28 codec renders the result
    // from these fields, and "waiting for a person" is a state. Section 3 had
    // to add an explanatory text block because no client of the day could read
    // `resultType`; the package now carries the meaning itself.
    expect(result.resultType).toBe('input_required');
    expect((result as ToolResult).isError).toBeUndefined();
  });

  it('records the key as awaiting a value while it asks', async () => {
    const f = fake();
    await call(f, { key: 'STRIPE_SECRET_KEY' });
    expect(f.requested).toEqual([['STRIPE_SECRET_KEY']]);
    expect(f.pending.has('STRIPE_SECRET_KEY')).toBe(true);
  });

  // The rule with no second chance. A `value` field in the requested schema
  // would carry the secret back through the client, and through the model.
  it('asks for a confirmation, never for the value itself', async () => {
    const f = fake();
    const result = await call(f, { key: 'STRIPE_SECRET_KEY' });
    expect(
      Object.keys(asked(result).params.requestedSchema.properties),
    ).toEqual(['delivered']);
    expect(JSON.stringify(result)).not.toMatch(/"value"/);
  });

  it('hands back a command for a person to run, not one it runs itself', async () => {
    const f = fake();
    const result = await call(f, { key: 'STRIPE_SECRET_KEY' });
    expect(asked(result).params.message).toContain(
      'flui app env set my-api STRIPE_SECRET_KEY',
    );
  });

  it('accepts no value argument at all', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(Object.keys(TOOL.inputSchema).sort(byName)).toEqual([
      'applicationId',
      'key',
    ]);
  });

  // The loop-breaker: a retry that finds the value still missing completes
  // plainly. Asking again forever is a spin dressed up as a protocol.
  it('completes with a waiting state when the retry finds nothing delivered', async () => {
    const f = fake();
    const result = await call(
      f,
      { key: 'STRIPE_SECRET_KEY' },
      round({
        inputResponses: {
          delivered: { action: 'accept', content: { delivered: true } },
        },
      }),
    );
    const parsed = body(result);

    expect(result.resultType).toBeUndefined();
    expect((result as ToolResult).isError).toBeUndefined();
    expect(parsed.awaitingPerson).toBe(true);
    expect(parsed.configured).toBe(false);
  });

  it('says configured, and nothing more, once the value has arrived', async () => {
    const f = fake({ configured: new Set(['STRIPE_SECRET_KEY']) });
    const result = await call(f, { key: 'STRIPE_SECRET_KEY' });

    expect(body(result).configured).toBe(true);
    expect(f.requested).toEqual([]);
    expect(text(result)).not.toContain(SECRET);
  });

  // Asking again for a key that already holds a value must not wipe it.
  it('reports a refusal as a state, not as an error', async () => {
    const f = fake({
      skip: {
        name: 'DB_PASSWORD',
        reason: 'linked to a building-block secret',
      },
    });
    const result = await call(f, { key: 'DB_PASSWORD' });
    const parsed = body(result);

    expect((result as ToolResult).isError).toBeUndefined();
    expect(parsed.requested).toBe(false);
    expect(parsed.note).toContain('building-block');
  });

  it('carries correlation state that decides nothing', async () => {
    const f = fake();
    const result = await call(f, { key: 'STRIPE_SECRET_KEY' });
    // It exists, because MRTR wants a way to correlate the rounds...
    expect(
      JSON.parse((result as InputRequiredResult).requestState as string),
    ).toEqual({
      app: 'app-1',
      key: 'STRIPE_SECRET_KEY',
    });

    // ...but a forged one changes nothing: the application and the key come
    // from the validated arguments on every round. This is what makes it safe
    // to hand it back unsigned and unverified.
    const forged = fake();
    await call(
      forged,
      { key: 'STRIPE_SECRET_KEY' },
      round({
        requestState: JSON.stringify({
          app: 'someone-elses-app',
          key: 'THEIR_KEY',
        }),
      }),
    );
    expect(forged.requested).toEqual([['STRIPE_SECRET_KEY']]);
  });
});
