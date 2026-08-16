import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VaultAgent, askAgent, socketIsSafe, socketPath } from './vault-agent';
import { deriveMasterKey, deriveProfileKey, open, seal } from './vault-crypto';
import { DEFAULT_IDLE_MS, DEFAULT_MAX_MS } from './vault-session';

const MASTER = deriveMasterKey('a passphrase', Buffer.alloc(16, 3));
const LIMITS = { idleMs: DEFAULT_IDLE_MS, maxMs: DEFAULT_MAX_MS };

describe('VaultAgent', () => {
  let base: string;
  let agent: VaultAgent | null = null;
  let closedWith: string | null = null;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'flui-agent-'));
    closedWith = null;
  });

  afterEach(() => {
    agent?.close('test teardown');
    agent = null;
    rmSync(base, { recursive: true, force: true });
  });

  async function start(limits = LIMITS): Promise<VaultAgent> {
    agent = new VaultAgent(base, limits, (reason) => {
      closedWith = reason;
    });
    await agent.listen(Buffer.from(MASTER) as typeof MASTER);
    return agent;
  }

  it('hands back a key that opens what that profile sealed', async () => {
    await start();
    const response = await askAgent(
      { op: 'profile-key', profile: 'default' },
      base,
    );

    expect(response?.ok).toBe(true);
    const key = Buffer.from(response!.key!, 'base64') as never;
    expect(open(key, seal(key, 'hcloud-token'))).toBe('hcloud-token');
  });

  it('never hands back the master key itself', async () => {
    await start();
    const response = await askAgent(
      { op: 'profile-key', profile: 'default' },
      base,
    );
    expect(response!.key).not.toEqual(MASTER.toString('base64'));
  });

  it('gives each profile a key that cannot open another', async () => {
    // A command working in one profile must not be able to reach a different
    // account's credentials, even though one passphrase covers both.
    await start();
    const a = await askAgent(
      { op: 'profile-key', profile: 'production-hz' },
      base,
    );
    const b = await askAgent(
      { op: 'profile-key', profile: 'scalaway-test' },
      base,
    );

    const keyA = Buffer.from(a!.key!, 'base64') as never;
    const keyB = Buffer.from(b!.key!, 'base64') as never;
    expect(() => open(keyB, seal(keyA, 'production-secret'))).toThrow();
  });

  it('matches the key that would be derived directly from the master', async () => {
    await start();
    const response = await askAgent(
      { op: 'profile-key', profile: 'default' },
      base,
    );
    expect(response!.key).toBe(
      deriveProfileKey(MASTER, 'default').toString('base64'),
    );
  });

  it('protects the socket with filesystem permissions', async () => {
    // This is the whole access control: another user must not be able to reach
    // the socket, exactly as ssh-agent does it.
    await start();
    expect(statSync(socketPath(base)).mode & 0o077).toBe(0);
    expect(statSync(base).mode & 0o077).toBe(0);
    expect(socketIsSafe(base)).toBe(true);
  });

  it('reports how long it has left without counting that as use', async () => {
    // Polling status must not be able to hold the vault open forever.
    await start();
    const first = await askAgent({ op: 'status' }, base);
    expect(first?.ok).toBe(true);
    expect(first?.state).toMatchObject({ open: true });

    const second = await askAgent({ op: 'status' }, base);
    const a = first!.state as { idleRemainingMs: number };
    const b = second!.state as { idleRemainingMs: number };
    expect(b.idleRemainingMs).toBeLessThanOrEqual(a.idleRemainingMs);
  });

  it('locks on request and leaves no socket behind', async () => {
    await start();
    expect(await askAgent({ op: 'lock' }, base)).toMatchObject({ ok: true });
    expect(existsSync(socketPath(base))).toBe(false);
    expect(closedWith).toBe('locked on request');
    agent = null;
  });

  it('refuses to serve a key once the session has expired', async () => {
    // Zero-length limits stand in for an eight-hour cap without waiting for it.
    await start({ idleMs: 0, maxMs: 0 });
    const response = await askAgent(
      { op: 'profile-key', profile: 'default' },
      base,
    );
    expect(response?.ok).toBe(false);
    expect(response?.error).toMatch(/locked/i);
    agent = null;
  });

  it('rejects a malformed request instead of crashing', async () => {
    await start();
    const response = await askAgent({ op: 'not-an-op' as never }, base);
    expect(response?.ok).toBe(false);
  });

  it('requires a profile name', async () => {
    await start();
    expect(await askAgent({ op: 'profile-key' }, base)).toMatchObject({
      ok: false,
    });
  });
});

describe('askAgent', () => {
  it('returns null when no agent is running, rather than failing', async () => {
    // A locked vault is a normal state: the caller reads null as "ask for the
    // passphrase", not as an error to report.
    const base = mkdtempSync(join(tmpdir(), 'flui-agent-'));
    try {
      expect(await askAgent({ op: 'status' }, base)).toBeNull();
      expect(socketIsSafe(base)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
