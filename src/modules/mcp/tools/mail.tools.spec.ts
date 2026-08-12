import { MAIL_TOOLS } from './mail.tools';
import { ALL_TOOLS } from './tool-registry';
import { MCP_SCOPE, SCOPE_TIER } from '../constants/mcp-scopes';

describe('mail tools', () => {
  it('exposes no way for an agent to send mail', () => {
    // Not an oversight. An agent able to send from a verified domain is a
    // phishing primitive carrying the operator's own reputation: outbound,
    // irreversible, and indistinguishable at the receiver from mail the
    // operator wrote. Diagnosing delivery needs none of it.
    const senders = ALL_TOOLS.filter(
      (t) => /^mail_/.test(t.name) && /send|deliver|compose/.test(t.name),
    );
    expect(senders).toEqual([]);
  });

  it('keeps every mail tool in the read tier', () => {
    for (const tool of MAIL_TOOLS) {
      expect(SCOPE_TIER[tool.scope]).toBe('read');
    }
  });

  it('scopes mail apart from the rest of the read tier', () => {
    // Recipient addresses are personal data. An agent granted logs should not
    // thereby be granted everyone's email address.
    for (const tool of MAIL_TOOLS) {
      expect(tool.scope).toBe(MCP_SCOPE.MAIL_READ);
    }
    expect(MCP_SCOPE.MAIL_READ).not.toBe(MCP_SCOPE.OBS_READ);
  });

  it('is reachable from the registry under unique names', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const tool of MAIL_TOOLS) {
      expect(names.filter((n) => n === tool.name)).toHaveLength(1);
    }
  });

  it('compacts the event list, which is mostly repetition, down to the failures', async () => {
    const events = [
      { kind: 'delivered', recipient: 'a@example.com' },
      { kind: 'delivered', recipient: 'b@example.com' },
      {
        kind: 'bounced',
        recipient: 'gone@example.com',
        reason: '550 5.1.1 user unknown',
      },
    ];
    const tool = MAIL_TOOLS.find((t) => t.name === 'mail_events')!;

    const projected = tool.forModel!(events) as Record<string, unknown>;

    expect(projected.total).toBe(3);
    expect(projected.by_kind).toEqual({ delivered: 2, bounced: 1 });
    expect(projected.failures).toHaveLength(1);
    expect(
      (projected.failures as Array<Record<string, unknown>>)[0]!.recipient,
    ).toBe('gone@example.com');
  });

  it('flags a truncated failure list rather than quietly cutting it', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      kind: 'bounced',
      recipient: `x${i}@example.com`,
    }));
    const tool = MAIL_TOOLS.find((t) => t.name === 'mail_events')!;

    const projected = tool.forModel!(events) as Record<string, unknown>;

    expect(projected.failures).toHaveLength(25);
    expect(projected.failures_truncated).toBe(true);
    expect(projected.total).toBe(30);
  });
});
