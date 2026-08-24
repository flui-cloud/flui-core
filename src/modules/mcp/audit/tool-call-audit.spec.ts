import { CATALOG_TOOLS } from '../tools/catalog.tools';
import { McpToolContext, ToolDef, runTool } from '../tools/mcp-tool.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { REDACTED } from './tool-arg-redaction';
import { Actor } from '../../auth/utils/actor-context';

const OPERATION_ID = '3f1a9b0e-2c4d-4e6f-8a1b-9c0d1e2f3a4b';
const KEY_ID = '11111111-2222-3333-4444-555555555555';
const PASSWORD = 'hunter2-correct-horse';

const install = (): ToolDef => {
  const tool = CATALOG_TOOLS.find((t) => t.name === 'app_install');
  if (!tool) throw new Error('app_install not found');
  return tool;
};

interface Ctx {
  ctx: McpToolContext;
  record: jest.Mock;
}

const ctxFor = (
  actor: Actor | undefined,
  scopes: string[] = [MCP_SCOPE.APP_WRITE],
): Ctx => {
  const record = jest.fn().mockResolvedValue(undefined);
  const reply = (path: string): unknown =>
    path === '/infrastructure/clusters'
      ? [{ id: 'c1', name: 'one' }]
      : {
          id: 'install-1',
          displayName: 'Photos',
          status: 'PENDING',
          operationId: OPERATION_ID,
        };
  const ctx = {
    user: { userId: 'u1', email: 'e@x' },
    scopes: new Set(scopes),
    allowDestructive: true,
    surface: 'mcp',
    actor,
    audit: { record },
    api: {
      get: (path: string) => Promise.resolve(reply(path)),
      post: (path: string) => Promise.resolve(reply(path)),
      put: (path: string) => Promise.resolve(reply(path)),
      patch: (path: string) => Promise.resolve(reply(path)),
      delete: (path: string) => Promise.resolve(reply(path)),
    },
  } as unknown as McpToolContext;
  return { ctx, record };
};

const ARGS = {
  slug: 'immich',
  displayName: 'Photos',
  exposure: 'public',
  authMode: 'oidc',
  options: { smtp: true },
  userInputs: { ADMIN_PASSWORD: PASSWORD },
  envOverrides: { STRIPE_SECRET_KEY: 'sk_live_51H8xQabcdef' },
};

describe('what a tool call leaves behind', () => {
  it('never writes a secret an argument carried', async () => {
    // The whole point of the round. `app_install` is the tool that takes both
    // `userInputs` and `envOverrides`, which is where an admin password and an
    // API key actually travel; MRTR exists so a secret never rides in a tool
    // call, and a log of raw arguments would put them back in the database in
    // clear.
    const { ctx, record } = ctxFor({ kind: 'agent', keyId: KEY_ID });
    await runTool(ctx, install(), ARGS);

    const written = JSON.stringify(record.mock.calls);
    expect(written).not.toContain(PASSWORD);
    expect(written).not.toContain('sk_live');
    expect(written).not.toContain('ADMIN_PASSWORD');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {
          slug: REDACTED,
          displayName: REDACTED,
          exposure: 'public',
          authMode: 'oidc',
          options: REDACTED,
          userInputs: REDACTED,
          envOverrides: REDACTED,
        },
      }),
    );
  });

  it('records which key acted, not only whom it acted for', async () => {
    const { ctx, record } = ctxFor({ kind: 'agent', keyId: KEY_ID });
    await runTool(ctx, install(), ARGS);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        actor: { kind: 'agent', keyId: KEY_ID },
      }),
    );
  });

  it('records the handle of the operation the call started', async () => {
    const { ctx, record } = ctxFor({ kind: 'agent', keyId: KEY_ID });
    await runTool(ctx, install(), ARGS);
    // The join that gives the redaction its usefulness back: the operations row
    // carries which app on which cluster, and the server wrote it.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: OPERATION_ID }),
    );
  });

  it('records the attempt, redacted, when the scope refuses the call', async () => {
    const { ctx, record } = ctxFor({ kind: 'agent', keyId: KEY_ID }, []);
    await runTool(ctx, install(), ARGS);
    const written = JSON.stringify(record.mock.calls);
    expect(written).not.toContain(PASSWORD);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        allowed: false,
        actor: { kind: 'agent', keyId: KEY_ID },
        args: expect.objectContaining({ exposure: 'public' }),
      }),
    );
  });

  it('writes no actor at all rather than guessing one', async () => {
    const { ctx, record } = ctxFor(undefined);
    await runTool(ctx, install(), ARGS);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: undefined }),
    );
  });
});
