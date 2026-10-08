import { redactHeartbeat } from './heartbeat-redaction.interceptor';

describe('redactHeartbeat', () => {
  const policy = (url?: string) => ({
    id: 'p1',
    metadata: {
      other: 1,
      platform: { recipient: 'age1x', heartbeat: url ? { url } : undefined },
    },
  });

  it('says where the heartbeat goes, never the address', () => {
    const out = redactHeartbeat(policy('https://hc-ping.com/secret-uuid'));
    expect(out.metadata.platform.heartbeat).toEqual({
      set: true,
      host: 'hc-ping.com',
    });
    expect(JSON.stringify(out)).not.toContain('secret-uuid');
    expect(out.metadata.platform.recipient).toBe('age1x');
    expect(out.metadata.other).toBe(1);
  });

  it('covers every policy in a list and leaves the rest untouched', () => {
    const [a, b] = redactHeartbeat([policy('https://hc-ping.com/s'), policy()]);
    expect(a.metadata.platform.heartbeat).toEqual({
      set: true,
      host: 'hc-ping.com',
    });
    expect(b).toEqual(policy());
  });

  it('leaves anything that is not a policy alone', () => {
    expect(redactHeartbeat({ ok: true })).toEqual({ ok: true });
    expect(redactHeartbeat(null)).toBeNull();
  });
});
