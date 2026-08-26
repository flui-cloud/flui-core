import { ServerRef } from './provider-server-ref';

describe('ServerRef', () => {
  it('recognises a Scaleway attachment reported as a bare uuid', () => {
    const server = ServerRef.parse('instance:fr-par-1:abc-123');
    expect(server?.ownsAttachment('abc-123')).toBe(true);
  });

  it('recognises the same server in either spelling, in both directions', () => {
    const zoned = ServerRef.parse('instance:fr-par-1:abc-123');
    const bare = ServerRef.parse('abc-123');
    expect(zoned?.ownsAttachment('fr-par-1:abc-123')).toBe(true);
    expect(bare?.ownsAttachment('instance:fr-par-1:abc-123')).toBe(true);
  });

  it('passes Hetzner bare numeric ids through untouched', () => {
    const server = ServerRef.parse('12345');
    expect(server?.ownsAttachment('12345')).toBe(true);
    expect(server?.ownsAttachment('12346')).toBe(false);
  });

  it('ignores case, whitespace and the family prefix', () => {
    const server = ServerRef.parse('  instance:fr-par-1:ABC-123 ');
    expect(server?.ownsAttachment('baremetal:fr-par-1:abc-123')).toBe(true);
  });

  it('does not match a different server', () => {
    const server = ServerRef.parse('instance:fr-par-1:abc-123');
    expect(server?.ownsAttachment('def-456')).toBe(false);
    expect(server?.ownsAttachment('instance:nl-ams-1:def-456')).toBe(false);
  });

  it('treats an unattached volume as not mine, never as free', () => {
    const server = ServerRef.parse('instance:fr-par-1:abc-123');
    expect(server?.ownsAttachment(null)).toBe(false);
    expect(server?.ownsAttachment(undefined)).toBe(false);
    expect(server?.ownsAttachment('')).toBe(false);
    expect(server?.ownsAttachment('instance:fr-par-1:')).toBe(false);
  });

  it('refuses to build from an unreadable id', () => {
    expect(ServerRef.parse('')).toBeNull();
    expect(ServerRef.parse('   ')).toBeNull();
    expect(ServerRef.parse('instance:fr-par-1:')).toBeNull();
    expect(ServerRef.parse(null)).toBeNull();
    expect(ServerRef.parse(undefined)).toBeNull();
  });
});
