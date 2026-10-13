jest.mock('@modelcontextprotocol/node', () => ({ toNodeHandler: jest.fn() }));
jest.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: jest.fn(),
}));

import { McpController } from './mcp.controller';

describe('McpController per-person limit', () => {
  const build = (hits: number) => {
    const throttler = {
      increment: jest.fn(async () => ({ totalHits: hits, timeToExpire: 30 })),
    };
    const controller = new McpController(
      {} as never,
      {} as never,
      throttler as never,
    );
    const dispatch = jest
      .spyOn(
        controller as unknown as { dispatch: () => Promise<void> },
        'dispatch',
      )
      .mockResolvedValue(undefined);
    return { controller, throttler, dispatch };
  };
  const req = { user: { userId: 'u-1' } } as never;

  it('counts every request of a person, keyed by the person', async () => {
    const t = build(1);
    await t.controller.handlePost(req, {} as never);
    expect(t.throttler.increment).toHaveBeenCalledWith(
      'user:u-1',
      60_000,
      60,
      0,
      'mcp',
    );
    expect(t.dispatch).toHaveBeenCalled();
  });

  it('refuses a person past the limit before serving anything', async () => {
    const t = build(61);
    await expect(
      t.controller.handlePost(req, {} as never),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'MCP_RATE_LIMIT' },
    });
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    [
      { jsonrpc: '2.0', method: 'notifications/cancelled' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ],
  ])('does not count keep-alives and notifications (%j)', async (body) => {
    const t = build(61);
    await t.controller.handlePost(
      { user: { userId: 'u-1' }, body } as never,
      {} as never,
    );
    expect(t.throttler.increment).not.toHaveBeenCalled();
    expect(t.dispatch).toHaveBeenCalled();
  });

  it('counts a batch that carries a real call beside a notification', async () => {
    const t = build(1);
    await t.controller.handlePost(
      {
        user: { userId: 'u-1' },
        body: [
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        ],
      } as never,
      {} as never,
    );
    expect(t.throttler.increment).toHaveBeenCalledTimes(1);
  });
});
