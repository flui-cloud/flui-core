import { mcpServerInstructions } from './mcp-server.factory';

describe('mcpServerInstructions', () => {
  const text = mcpServerInstructions({
    dashboardUrl: 'https://app.acme.dev',
    apiUrl: 'https://api.acme.dev/api/v1',
  });

  it('names the instance by its dashboard and API addresses', () => {
    expect(text).toContain('https://app.acme.dev');
    expect(text).toContain('https://api.acme.dev/api/v1');
  });

  it('sends the agent to get_started first and to my_permissions for its reach', () => {
    expect(text).toContain('`get_started` before anything else');
    expect(text).toContain('`my_permissions`');
  });

  it('says a pending approval comes back as a link to relay', () => {
    expect(text).toContain('approval_required');
    expect(text).toContain('link');
  });

  it('stays a few lines long', () => {
    expect(text.split('\n').length).toBeLessThanOrEqual(5);
  });
});
