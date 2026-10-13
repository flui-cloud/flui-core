import { countsTowardMcpLimit, mcpRequestLimit } from './mcp-rate-limit';

describe('mcpRequestLimit', () => {
  it('is 60 a minute unless the instance says otherwise', () => {
    expect(mcpRequestLimit({})).toMatchObject({ limit: 60, ttlMs: 60_000 });
    expect(mcpRequestLimit({ MCP_REQUESTS_PER_MINUTE: '120' }).limit).toBe(120);
    expect(mcpRequestLimit({ MCP_REQUESTS_PER_MINUTE: 'x' }).limit).toBe(60);
    expect(mcpRequestLimit({ MCP_REQUESTS_PER_MINUTE: '0' }).limit).toBe(60);
  });
});

describe('countsTowardMcpLimit', () => {
  it('leaves out ping and notifications, alone or in a batch', () => {
    expect(countsTowardMcpLimit({ method: 'ping' })).toBe(false);
    expect(countsTowardMcpLimit({ method: 'notifications/initialized' })).toBe(
      false,
    );
    expect(
      countsTowardMcpLimit([
        { method: 'ping' },
        { method: 'notifications/cancelled' },
      ]),
    ).toBe(false);
  });

  it('counts real calls and anything it cannot read', () => {
    expect(countsTowardMcpLimit({ method: 'tools/call' })).toBe(true);
    expect(
      countsTowardMcpLimit([{ method: 'ping' }, { method: 'tools/list' }]),
    ).toBe(true);
    expect(countsTowardMcpLimit(undefined)).toBe(true);
    expect(countsTowardMcpLimit([])).toBe(true);
    expect(countsTowardMcpLimit({ method: 'pings' })).toBe(true);
  });
});
