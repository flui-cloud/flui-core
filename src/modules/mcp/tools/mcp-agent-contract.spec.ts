import { z } from 'zod';
import {
  McpToolContext,
  ToolDef,
  defineTool,
  isExecutable,
  readOperationOutcome,
  runTool,
  toolInputSchema,
} from './mcp-tool.util';
import { ALL_TOOLS, toOpenAiTool } from './tool-registry';
import { MCP_SCOPE } from '../constants/mcp-scopes';

const ctxWith = (over: Partial<McpToolContext> = {}): McpToolContext =>
  ({
    user: { userId: 'u1', email: 'e@x' },
    scopes: new Set<string>(Object.values(MCP_SCOPE)),
    allowDestructive: true,
    surface: 'mcp',
    audit: { record: jest.fn() },
    services: {},
    ...over,
  }) as unknown as McpToolContext;

/**
 * The contract an external coding agent depends on. Each case guards against a
 * plausible, successful-looking answer that is wrong — the one failure mode an
 * agent cannot detect on its own.
 */
describe('MCP agent contract', () => {
  describe('unknown arguments are rejected, never silently dropped', () => {
    const schema = toolInputSchema({ search: z.string().optional() });

    it('rejects a plausible-but-wrong argument name instead of ignoring it', () => {
      const result = schema.safeParse({ query: 'postgres' });
      expect(result.success).toBe(false);
    });

    it('names the offending key and the accepted keys, so the agent can self-correct', () => {
      const result = schema.safeParse({ query: 'postgres' });
      const message = result.success ? '' : result.error.issues[0].message;
      expect(message).toContain('query');
      expect(message).toContain('search');
    });

    it('still accepts the declared arguments', () => {
      expect(schema.safeParse({ search: 'postgres' })).toMatchObject({
        success: true,
      });
    });

    it.each(ALL_TOOLS.map((d) => d.name))(
      'publishes additionalProperties:false for %s, so the model sees the constraint',
      (name) => {
        const def = ALL_TOOLS.find((d) => d.name === name)!;
        const params = toOpenAiTool(def).function.parameters as Record<
          string,
          unknown
        >;
        expect(params.additionalProperties).toBe(false);
      },
    );
  });

  describe('compact projections reach the MCP client', () => {
    const bulky = defineTool({
      name: 'probe_tool',
      description: 'probe',
      inputSchema: {},
      scope: MCP_SCOPE.APP_READ,
      run: () => Promise.resolve({ id: 'a1', secretish: 'x'.repeat(500) }),
      forModel: (data) => ({ id: (data as { id: string }).id }),
    }) as ToolDef;

    it('applies forModel — the MCP client is the model, there is no separate UI', async () => {
      const result = await runTool(ctxWith(), bulky, {});
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 'a1' });
    });

    it('passes the raw result through when a tool declares no projection', async () => {
      const plain = { ...bulky, forModel: undefined } as ToolDef;
      const result = await runTool(ctxWith(), plain, {});
      expect(JSON.parse(result.content[0].text)).toHaveProperty('secretish');
    });
  });

  describe('only executable tools are advertised', () => {
    const readTool = ALL_TOOLS.find((d) => d.scope === MCP_SCOPE.APP_READ)!;
    const destructive = ALL_TOOLS.find(
      (d) => d.scope === MCP_SCOPE.APP_DESTRUCTIVE,
    )!;

    it('hides a tool whose scope the principal was never granted', () => {
      const ctx = ctxWith({ scopes: new Set<string>() });
      expect(isExecutable(ctx, readTool)).toBe(false);
    });

    it('hides destructive tools while the server-wide flag is off', () => {
      expect(
        isExecutable(ctxWith({ allowDestructive: false }), destructive),
      ).toBe(false);
    });

    it('shows destructive tools once the flag is on and the scope is granted', () => {
      expect(isExecutable(ctxWith(), destructive)).toBe(true);
    });
  });

  describe('async-operation guidance is addressed to the actual caller', () => {
    const started = {
      operations: {
        getOperationDetails: jest.fn().mockResolvedValue({ status: 'RUNNING' }),
      },
    };

    it('tells an MCP client to poll operation_status — nothing else will', async () => {
      const ctx = ctxWith({ surface: 'mcp', services: started as never });
      const outcome = await readOperationOutcome(ctx, 'op1');
      expect(outcome.note).toContain('operation_status');
      expect(outcome.note).not.toContain('progress widget');
    });

    it('keeps the widget promise for the in-product assistant, where it is true', async () => {
      const ctx = ctxWith({ surface: 'assistant', services: started as never });
      const outcome = await readOperationOutcome(ctx, 'op1');
      expect(outcome.note).toContain('progress widget');
    });

    it('reports a failure the same way on both surfaces', async () => {
      const failed = {
        operations: {
          getOperationDetails: jest.fn().mockResolvedValue({
            status: 'FAILED',
            errorMessage: 'boom',
          }),
        },
      };
      const ctx = ctxWith({ surface: 'mcp', services: failed as never });
      const outcome = await readOperationOutcome(ctx, 'op1');
      expect(outcome.done).toBe(true);
      expect(outcome.note).toContain('FAILED');
    });
  });
});
