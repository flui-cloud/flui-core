import { McpToolContext, ToolResult, runGated } from './mcp-tool.util';
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
  const ctx = (over: Partial<McpToolContext> = {}): McpToolContext =>
    ({
      user: { userId: 'u1', email: 'e@x' },
      scopes: new Set([MCP_SCOPE.APP_WRITE]),
      allowDestructive: true,
      audit: { record: jest.fn() },
      clientElicitsUrl: true,
      ...over,
    }) as unknown as McpToolContext;

  const pending = (
    estimateWithheld = false,
    decideUrl: string | null = 'https://console.test/agents/requests/p-1',
  ) =>
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
        decideUrl: decideUrl ?? undefined,
        estimateWithheld,
      },
    );

  it('comes back as input_required to a client that declared URL elicitation', async () => {
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
      'https://console.test/agents/requests/p-1',
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
      expect.objectContaining({
        outcome: 'input_required',
        allowed: true,
        // What it asked for, not only that it asked: the register walks a
        // review from a request to the calls it came out of, and without this
        // the column that does the walking is null on every row.
        proposalId: 'p-1',
      }),
    );
  });

  /**
   * The estimate is a route the guard never calls, so there is no figure to
   * hand over — and a route handed to a model is a call it cannot make. What
   * has to cross is that a price exists, because an agent that says nothing
   * about it lets the person decide from a summary that reads as free.
   */
  it('says a price is attached when one is, instead of staying silent', async () => {
    const c = ctx();
    const result = await runGated(c, 'app_deploy', MCP_SCOPE.APP_WRITE, () =>
      Promise.reject(pending(true)),
    );
    const message = (
      result as unknown as {
        inputRequests: Record<string, { params: { message: string } }>;
      }
    ).inputRequests.approved.params.message;
    expect(message).toContain('cost estimate attached');
    expect(message).not.toContain('capacity-plan');

    const silent = await runGated(c, 'app_deploy', MCP_SCOPE.APP_WRITE, () =>
      Promise.reject(pending(false)),
    );
    expect(
      (
        silent as unknown as {
          inputRequests: Record<string, { params: { message: string } }>;
        }
      ).inputRequests.approved.params.message,
    ).not.toContain('cost estimate attached');
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

  const text = (result: unknown) =>
    (result as ToolResult).content.map((c) => c.text).join('\n');
  const fields = (result: unknown) =>
    JSON.parse((result as ToolResult).content[1].text) as Record<
      string,
      unknown
    >;

  /**
   * Seen live: a client that never declared it renders a URL elicitation got
   * one anyway, answered it with nobody looking, and ran out of rounds. The
   * person never heard a request was waiting. Undeclared now means words.
   */
  describe('to a client that did not declare URL elicitation', () => {
    it('is an ordinary result an agent relays, not an error', async () => {
      const c = ctx({ clientElicitsUrl: undefined });
      const result = await runGated(
        c,
        'repo_connect',
        MCP_SCOPE.APP_WRITE,
        () => Promise.reject(pending()),
      );
      expect(isInputRequired(result)).toBe(false);
      expect((result as ToolResult).isError).toBeUndefined();
      expect(text(result)).toContain(
        '"This needs your approval: open https://console.test/agents/requests/p-1 and approve it, then tell me and I will retry."',
      );
      expect(text(result)).toContain('Requested: deploy application app-1');
      expect(text(result)).toMatch(/Do NOT retry until they confirm/);
      expect(text(result)).toMatch(/IDENTICAL call/);
    });

    it('keeps the fields a program reads', async () => {
      const result = await runGated(
        ctx({ clientElicitsUrl: false }),
        'repo_connect',
        MCP_SCOPE.APP_WRITE,
        () => Promise.reject(pending()),
      );
      expect(fields(result)).toEqual(
        expect.objectContaining({
          status: 'approval_required',
          proposalId: 'p-1',
          approveUrl: 'https://console.test/agents/requests/p-1',
          request: 'deploy application app-1 whenever it asks',
        }),
      );
    });

    it('is audited exactly like the elicitation', async () => {
      const c = ctx({ clientElicitsUrl: false });
      await runGated(c, 'repo_connect', MCP_SCOPE.APP_WRITE, () =>
        Promise.reject(pending()),
      );
      expect(c.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'input_required',
          allowed: true,
          proposalId: 'p-1',
        }),
      );
    });

    it('carries the price note too', async () => {
      const result = await runGated(
        ctx({ clientElicitsUrl: false }),
        'app_deploy',
        MCP_SCOPE.APP_WRITE,
        () => Promise.reject(pending(true)),
      );
      expect(text(result)).toContain('cost estimate attached');
    });
  });

  /**
   * A declaring client gets one elicitation. If it comes back still pending,
   * asking again is the loop that exhausted the round cap: say it in words.
   */
  describe('to a client that already answered the elicitation', () => {
    it.each([
      [
        'an accepted answer',
        { inputResponses: { approved: { action: 'accept' } } },
      ],
      [
        'a declined answer',
        { inputResponses: { approved: { action: 'decline' } } },
      ],
      ['an answer the SDK dropped', { droppedInputResponseKeys: ['approved'] }],
    ])('stops eliciting after %s', async (_label, round) => {
      const result = await runGated(
        ctx({ mcpReq: round }),
        'repo_connect',
        MCP_SCOPE.APP_WRITE,
        () => Promise.reject(pending()),
      );
      expect(isInputRequired(result)).toBe(false);
      expect((result as ToolResult).isError).toBeUndefined();
      expect(fields(result).status).toBe('approval_required');
    });
  });

  describe('the link it gives', () => {
    it('joins a relative decideUrl to the dashboard', async () => {
      const result = await runGated(
        ctx({
          clientElicitsUrl: false,
          dashboardUrl: 'https://app.flui.test/',
        }),
        'repo_connect',
        MCP_SCOPE.APP_WRITE,
        () => Promise.reject(pending(false, '/agents/requests/p-1')),
      );
      expect(fields(result).approveUrl).toBe(
        'https://app.flui.test/agents/requests/p-1',
      );
    });

    it('builds it from the dashboard when the API stated none', async () => {
      const result = await runGated(
        ctx({ dashboardUrl: 'https://app.flui.test' }),
        'repo_connect',
        MCP_SCOPE.APP_WRITE,
        () => Promise.reject(pending(false, null)),
      );
      const requests = (
        result as unknown as {
          inputRequests: Record<string, { params: { url: string } }>;
        }
      ).inputRequests;
      expect(requests.approved.params.url).toBe(
        'https://app.flui.test/agents/requests/p-1',
      );
    });
  });
});
