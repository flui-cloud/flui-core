import { MCP_SCOPE } from '../constants/mcp-scopes';
import { InputRequiredResult } from '../protocol/mrtr';
import { McpToolContext, ToolDef, ToolResult, runTool } from './mcp-tool.util';
import { REPO_TOOLS } from './repo.tools';

const CONNECT = REPO_TOOLS.find((t) => t.name === 'github_connect')! as ToolDef;

function ctxAnswering(replies: Record<string, unknown>, calls: string[] = []) {
  return {
    user: { userId: 'u1', email: 'e@x' },
    scopes: new Set<string>(Object.values(MCP_SCOPE)),
    allowDestructive: true,
    surface: 'mcp',
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    api: {
      get: (path: string) => {
        calls.push(path);
        return Promise.resolve(replies[path.split('?')[0]] ?? {});
      },
    },
  } as unknown as McpToolContext;
}

const body = (result: ToolResult | InputRequiredResult) =>
  JSON.parse((result as ToolResult).content[0].text);

describe('github_connect on an installation that uses personal access tokens', () => {
  const setup = {
    '/repositories/github/setup/status': {
      configured: true,
      authMethod: 'pat',
    },
  };

  it('hands the person the step where they paste their own token, never the App install', async () => {
    const calls: string[] = [];
    const result = body(
      await runTool(
        ctxAnswering(
          { ...setup, '/repositories/github/status': { connected: false } },
          calls,
        ),
        CONNECT,
        {},
      ),
    );
    expect(result).toMatchObject({
      alreadyConnected: false,
      method: 'personal_access_token',
      cliAction: { command: 'flui integration connect github' },
      orInTheDashboard: { where: 'Repositories' },
    });
    expect(calls).not.toContain('/repositories/github-app/install-url');
  });

  it('says the account is connected when the token is already saved', async () => {
    const result = body(
      await runTool(
        ctxAnswering({
          ...setup,
          '/repositories/github/status': {
            connected: true,
            githubUsername: 'octocat',
          },
        }),
        CONNECT,
        {},
      ),
    );
    expect(result).toEqual({ alreadyConnected: true, login: 'octocat' });
  });
});

describe('github_connect before GitHub is set up', () => {
  it('names the setup, token first, instead of failing on a missing App', async () => {
    const calls: string[] = [];
    const result = body(
      await runTool(
        ctxAnswering(
          { '/repositories/github/setup/status': { configured: false } },
          calls,
        ),
        CONNECT,
        {},
      ),
    );
    expect(result).toMatchObject({
      alreadyConnected: false,
      configured: false,
    });
    expect(result.note).toMatch(/personal access tokens are the recommended/);
    expect(calls).toEqual(['/repositories/github/setup/status']);
  });
});
