import { createRequestStateCodec } from '@modelcontextprotocol/server';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';

/**
 * `requestState` travels through the client and comes back as input the other
 * side controls. Until decision 8 it came back raw: the seam handed the string
 * to the handler unverified, deliberately trusted with nothing, and the
 * obligation was left in plain sight rather than hidden behind an accessory that
 * looked safe without being it.
 *
 * These pin the two halves of closing it: the key is derived, never the platform
 * key itself, and the codec refuses everything it should.
 */
const KEY = 'a'.repeat(64); // 32 bytes, hex — the platform key shape

const encryptionWith = (hex: string): EncryptionService =>
  new EncryptionService({
    get: (name: string) => (name === 'ENCRYPTION_KEY' ? hex : undefined),
  } as never);

describe('the subkey the requestState codec is keyed by', () => {
  const svc = encryptionWith(KEY);

  it('is not the platform key, and is long enough to be an HMAC key', () => {
    const sub = svc.deriveSubkey('mcp.requestState');
    expect(sub).toHaveLength(32);
    expect(sub.toString('hex')).not.toBe(KEY);
  });

  it('is reproducible, so any replica can verify what another minted', () => {
    expect(svc.deriveSubkey('mcp.requestState')).toEqual(
      encryptionWith(KEY).deriveSubkey('mcp.requestState'),
    );
  });

  it('gives a different key to a different purpose', () => {
    expect(svc.deriveSubkey('mcp.requestState')).not.toEqual(
      svc.deriveSubkey('something.else'),
    );
  });

  it('gives a different key when the platform key differs', () => {
    expect(svc.deriveSubkey('mcp.requestState')).not.toEqual(
      encryptionWith('b'.repeat(64)).deriveSubkey('mcp.requestState'),
    );
  });
});

describe('a signed requestState round trip', () => {
  const key = encryptionWith(KEY).deriveSubkey('mcp.requestState');
  const codecFor = (userId: string) =>
    createRequestStateCodec<{ app: string; key: string }>({
      key,
      bind: () => userId,
    });
  const ctx = {} as never;
  const payload = { app: 'app-1', key: 'DATABASE_URL' };

  it('comes back as the payload that went in', async () => {
    const codec = codecFor('user-a');
    const wire = await codec.mint(payload, ctx);
    await expect(codec.verify(wire, ctx)).resolves.toEqual(payload);
  });

  it('does not carry the payload in the clear', async () => {
    const wire = await codecFor('user-a').mint(payload, ctx);
    expect(wire).not.toContain('DATABASE_URL');
    expect(wire).not.toContain('app-1');
  });

  it('refuses a state echoed by a different principal', async () => {
    const wire = await codecFor('user-a').mint(payload, ctx);
    await expect(codecFor('user-b').verify(wire, ctx)).rejects.toThrow();
  });

  it('refuses a tampered state', async () => {
    const wire = await codecFor('user-a').mint(payload, ctx);
    const tampered = `${wire.slice(0, -2)}${wire.slice(-2) === 'aa' ? 'bb' : 'aa'}`;
    await expect(codecFor('user-a').verify(tampered, ctx)).rejects.toThrow();
  });

  it('refuses a state signed with another key', async () => {
    const wire = await createRequestStateCodec({
      key: encryptionWith('b'.repeat(64)).deriveSubkey('mcp.requestState'),
      bind: () => 'user-a',
    }).mint(payload, ctx);
    await expect(codecFor('user-a').verify(wire, ctx)).rejects.toThrow();
  });
});
