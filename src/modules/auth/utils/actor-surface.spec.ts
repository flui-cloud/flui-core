import {
  AGENT_SURFACE_HEADER,
  agentSurfaceHeader,
  agentSurfaceOf,
} from './actor-surface';

/**
 * The declaration that survives one hop, and nothing else.
 *
 * The property being pinned is not "the header works". It is that **only this
 * process can make the declaration**: the surface changes what the register
 * records about who acted, and a register built to say "an agent did this, not
 * the person" must not accept the claim from whoever is asking.
 */
describe('the surface a call declares', () => {
  const headers = (value: unknown) => ({ [AGENT_SURFACE_HEADER]: value });

  it('reads back what this process sent', () => {
    expect(agentSurfaceOf(headers(agentSurfaceHeader('assistant')))).toBe(
      'assistant',
    );
    expect(agentSurfaceOf(headers(agentSurfaceHeader('mcp')))).toBe('mcp');
  });

  it('refuses a bare claim from a client', () => {
    // The whole point: `curl -H 'x-flui-agent-surface: assistant'` buys nothing.
    expect(agentSurfaceOf(headers('assistant'))).toBeUndefined();
    expect(agentSurfaceOf(headers('assistant.'))).toBeUndefined();
    expect(agentSurfaceOf(headers('assistant.deadbeef'))).toBeUndefined();
  });

  it('refuses a real token pinned to a surface nobody defined', () => {
    const real = agentSurfaceHeader('assistant');
    const token = real.slice(real.indexOf('.') + 1);
    expect(agentSurfaceOf(headers(`dashboard.${token}`))).toBeUndefined();
  });

  it('says nothing for every request that declares nothing', () => {
    expect(agentSurfaceOf(undefined)).toBeUndefined();
    expect(agentSurfaceOf({})).toBeUndefined();
    expect(agentSurfaceOf(headers(undefined))).toBeUndefined();
    expect(agentSurfaceOf(headers(['assistant']))).toBeUndefined();
    expect(agentSurfaceOf(headers(42))).toBeUndefined();
  });

  it('reads the first value when a header arrives repeated', () => {
    expect(
      agentSurfaceOf(headers([agentSurfaceHeader('mcp'), 'assistant'])),
    ).toBe('mcp');
  });
});
