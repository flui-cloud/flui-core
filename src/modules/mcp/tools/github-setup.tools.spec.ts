import { MCP_SCOPE } from '../constants/mcp-scopes';
import { InputRequiredResult } from '../protocol/mrtr';
import { McpToolContext, ToolDef, ToolResult, runTool } from './mcp-tool.util';
import { REPO_TOOLS } from './repo.tools';

const SETUP = REPO_TOOLS.find((t) => t.name === 'github_setup')! as ToolDef;

function ctxPosting(githubUrl: string, sent: unknown[]) {
  return {
    user: { userId: 'u1', email: 'e@x' },
    scopes: new Set<string>(Object.values(MCP_SCOPE)),
    allowDestructive: true,
    surface: 'mcp',
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    api: {
      post: (_path: string, body: unknown) => {
        sent.push(body);
        return Promise.resolve({
          manifestJson: { name: 'flui-acme' },
          githubUrl,
          state: 's1',
        });
      },
    },
  } as unknown as McpToolContext;
}

const body = (result: ToolResult | InputRequiredResult) =>
  JSON.parse((result as ToolResult).content[0].text);

describe('github_setup', () => {
  it('asks for the App under the organisation it is given, and submits to the URL the API returns', async () => {
    const sent: unknown[] = [];
    const orgUrl = 'https://github.com/organizations/acme/settings/apps/new';
    const result = body(
      await runTool(ctxPosting(orgUrl, sent), SETUP, {
        name: 'flui-acme',
        organization: 'acme',
      }),
    );

    expect(sent).toEqual([
      { name: 'flui-acme', organization: 'acme', webhooksEnabled: false },
    ]);
    expect(result.uiAction.url).toBe(`${orgUrl}?state=s1`);
  });

  it('sends the field the route requires even when nothing else is chosen', async () => {
    const sent: unknown[] = [];
    await runTool(
      ctxPosting('https://github.com/settings/apps/new', sent),
      SETUP,
      { name: 'flui-acme' },
    );

    expect(sent[0]).toMatchObject({ webhooksEnabled: false });
    expect((sent[0] as { organization?: string }).organization).toBeUndefined();
  });
});
