import { McpToolContext, runGated } from './mcp-tool.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { McpApiError } from '../services/mcp-api.client';
import { isInputRequired } from '../protocol/mrtr';
import { ACTION_PROPOSAL_CODE } from '../../action-cycle/action-cycle.core';

/**
 * How a pending request reaches an agent: as a **wait**, in the protocol's own
 * shape, not as a failure.
 *
 * The distinction is the whole reason the multi-round-trip pattern exists. An
 * agent that reads `isError` either retries blindly — which on a half-applied
 * mutation does damage — or abandons a task the person is about to allow. What
 * it has to do instead is stop, say what it asked for, and retry the identical
 * call once the answer exists.
 */
describe('a pending request, seen from the agent side', () => {
  const ctx = (): McpToolContext =>
    ({
      user: { userId: 'u1', email: 'e@x' },
      scopes: new Set([MCP_SCOPE.APP_WRITE]),
      allowDestructive: true,
      audit: { record: jest.fn() },
    }) as unknown as McpToolContext;

  const pending = () =>
    new McpApiError(
      403,
      'This call needs a person to allow it first.',
      'POST',
      '/applications/app-1/deploy',
      ACTION_PROPOSAL_CODE,
      undefined,
      {
        proposalId: 'p-1',
        action: 'POST /applications/:id/deploy',
        sentence: 'deploy application app-1 whenever it asks',
        offersAlways: true,
        decideUrl: 'https://console.test/settings/agents/requests/p-1',
      },
    );

  it('comes back as input_required, pointing at where a person decides', async () => {
    const c = ctx();
    const result = await runGated(c, 'app_deploy', MCP_SCOPE.APP_WRITE, () =>
      Promise.reject(pending()),
    );

    expect(isInputRequired(result)).toBe(true);
    const requests = (
      result as unknown as {
        inputRequests: Record<
          string,
          { params: { url: string; message: string } }
        >;
      }
    ).inputRequests;
    expect(requests.approved.params.url).toBe(
      'https://console.test/settings/agents/requests/p-1',
    );
    expect(requests.approved.params.message).toContain(
      'deploy application app-1',
    );
  });

  it('is recorded as a turn that stopped to ask, not as a refusal', async () => {
    const c = ctx();
    await runGated(c, 'app_deploy', MCP_SCOPE.APP_WRITE, () =>
      Promise.reject(pending()),
    );
    expect(c.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'input_required', allowed: true }),
    );
  });

  it('still tells a client with no round-trip channel what to do, in words', () => {
    // The assistant surface has no `mcpReq`, so the sentence is all it gets.
    expect(pending().agentMessage).toMatch(/Waiting on a person/);
    expect(pending().agentMessage).toMatch(/retry the IDENTICAL call/);
    expect(pending().isAccessRefusal).toBe(false);
  });

  it('leaves a real access refusal exactly as it was', async () => {
    const c = ctx();
    const denied = new McpApiError(
      403,
      "Not allowed to app:deploy on application 'x'",
      'POST',
      '/applications/app-1/deploy',
    );
    const result = await runGated(c, 'app_deploy', MCP_SCOPE.APP_WRITE, () =>
      Promise.reject(denied),
    );
    expect(isInputRequired(result)).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(denied.isAccessRefusal).toBe(true);
    expect(c.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: false }),
    );
  });

  it('leaves an ordinary failure exactly as it was', async () => {
    const c = ctx();
    const result = await runGated(c, 'app_deploy', MCP_SCOPE.APP_WRITE, () =>
      Promise.reject(new Error('boom')),
    );
    expect(isInputRequired(result)).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
