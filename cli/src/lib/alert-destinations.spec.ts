import { describeDestination, destinationBody } from './alert-destinations';

describe('alert destinations in the CLI', () => {
  it('builds the body from --email with a critical floor by default', () => {
    expect(destinationBody({ email: 'oncall@example.com' })).toEqual({
      kind: 'email',
      target: 'oncall@example.com',
      minSeverity: 'critical',
      scope: 'infrastructure',
    });
  });

  it('asks for every application’s alerts only when told to', () => {
    expect(
      destinationBody({ email: 'oncall@example.com', scope: 'all' }).scope,
    ).toBe('all');
  });

  it('builds the body from --webhook with the floor asked for', () => {
    expect(
      destinationBody({
        webhook: 'https://hooks.example.com/flui',
        'min-severity': 'warning',
      }),
    ).toEqual({
      kind: 'webhook',
      target: 'https://hooks.example.com/flui',
      minSeverity: 'warning',
      scope: 'infrastructure',
    });
  });

  it.each([{}, { email: 'a@example.com', webhook: 'https://x.example.com' }])(
    'insists on exactly one of --email or --webhook (%j)',
    (flags) => {
      expect(() => destinationBody(flags)).toThrow('exactly one');
    },
  );

  it('says how the last delivery went, or that there was none', () => {
    const base = {
      id: 'd1',
      kind: 'webhook' as const,
      target: 'https://hooks.example.com/flui',
      minSeverity: 'warning' as const,
      scope: 'infrastructure' as const,
      enabled: true,
      signed: true,
      createdBy: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      lastDeliveryAt: null,
      lastStatus: null,
      lastError: null,
    };
    expect(describeDestination(base)).toContain('nothing delivered yet');
    expect(describeDestination(base)).toContain('infrastructure');
    expect(describeDestination({ ...base, scope: 'all' })).toContain(
      'all apps',
    );
    expect(
      describeDestination({
        ...base,
        enabled: false,
        lastDeliveryAt: '2026-09-02T10:00:00.000Z',
        lastStatus: '500',
        lastError: 'HTTP 500',
      }),
    ).toMatch(/\(paused\)[\s\S]*last 500 at 2026-09-02 10:00:00 — HTTP 500/);
  });
});
