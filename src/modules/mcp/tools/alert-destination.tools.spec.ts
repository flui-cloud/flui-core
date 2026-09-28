import { OBSERVABILITY_TOOLS } from './observability.tools';
import { MCP_SCOPE } from '../constants/mcp-scopes';

const tool = (name: string) => {
  const found = OBSERVABILITY_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not found`);
  return found;
};

describe('alert destination tools', () => {
  it('reads with the machine-room read scope and writes with its write scope', () => {
    expect(tool('alert_destination_list').scope).toBe(MCP_SCOPE.INFRA_READ);
    for (const name of [
      'alert_destination_add',
      'alert_destination_remove',
      'alert_destination_test',
    ]) {
      expect(tool(name).scope).toBe(MCP_SCOPE.INFRA_WRITE);
    }
  });

  it('never hands a webhook signing secret to the model', () => {
    const projected = tool('alert_destination_add').forModel!({
      id: 'd1',
      kind: 'webhook',
      secret: 'abc123',
    }) as Record<string, unknown>;
    expect(projected).not.toHaveProperty('secret');
    expect(JSON.stringify(projected)).not.toContain('abc123');
    expect(projected.note).toMatch(/not shown to agents/);
  });

  it('passes an email destination through untouched', () => {
    const data = { id: 'd2', kind: 'email', secret: null };
    expect(tool('alert_destination_add').forModel!(data)).toEqual({
      id: 'd2',
      kind: 'email',
    });
  });

  it('passes the scope through, leaving the permission question to the API', async () => {
    const post = jest.fn().mockResolvedValue({ id: 'd3' });
    await tool('alert_destination_add').run(
      { kind: 'email', target: 'oncall@example.com', scope: 'all' },
      { api: { post } } as never,
    );
    expect(post).toHaveBeenCalledWith('/observability/alert-destinations', {
      kind: 'email',
      target: 'oncall@example.com',
      minSeverity: undefined,
      scope: 'all',
    });
  });
});
