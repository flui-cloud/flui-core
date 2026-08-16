import { resolveSshMode, revokeAuthorizedKeyCommand } from './ssh-mode';

const A_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN4HUbEWWOqQ2/kh41HZYcZd9F9BN1sKmXGxcDQwfjEI flui-bootstrap-x';
const KEY_BODY =
  'AAAAC3NzaC1lZDI1NTE5AAAAIN4HUbEWWOqQ2/kh41HZYcZd9F9BN1sKmXGxcDQwfjEI';

describe('resolveSshMode', () => {
  it('only accepts the exact opt-in string', () => {
    expect(resolveSshMode({ sshMode: 'ephemeral-key' })).toBe('ephemeral-key');
    for (const value of ['ephemeral', 'EPHEMERAL-KEY', true, 1, null]) {
      expect(resolveSshMode({ sshMode: value })).toBe('ca');
    }
  });

  it('defaults to ca for clusters created before the mode existed', () => {
    expect(resolveSshMode(undefined)).toBe('ca');
    expect(resolveSshMode(null)).toBe('ca');
    expect(resolveSshMode({})).toBe('ca');
  });
});

describe('revokeAuthorizedKeyCommand', () => {
  it('matches on the key body, not the whole line', () => {
    // cloud-init rewrites the comment field on some images, so a full-line
    // match would no-op and leave the key authorised while reporting success.
    const command = revokeAuthorizedKeyCommand(A_KEY);
    expect(command).toContain(KEY_BODY);
    expect(command).not.toContain('flui-bootstrap-x');
  });

  it('writes through a temporary file so an interrupted run cannot truncate the file', () => {
    const command = revokeAuthorizedKeyCommand(A_KEY);
    expect(command).toContain('authorized_keys.pruned');
    expect(command).toContain(
      'mv /root/.ssh/authorized_keys.pruned /root/.ssh/authorized_keys',
    );
    // Never a redirect straight onto the live file.
    expect(command).not.toMatch(/>\s*\/root\/\.ssh\/authorized_keys\s/);
  });

  it('restores ownership and mode on the replacement', () => {
    const command = revokeAuthorizedKeyCommand(A_KEY, 'ubuntu');
    expect(command).toContain('chmod 600');
    expect(command).toContain('chown ubuntu:');
  });

  it('targets the right home for a non-root user', () => {
    expect(revokeAuthorizedKeyCommand(A_KEY, 'ubuntu')).toContain(
      '/home/ubuntu/.ssh/authorized_keys',
    );
    expect(revokeAuthorizedKeyCommand(A_KEY)).toContain(
      '/root/.ssh/authorized_keys',
    );
  });

  it('does nothing when there is no authorized_keys to prune', () => {
    expect(revokeAuthorizedKeyCommand(A_KEY)).toMatch(
      /^if \[ -f \/root\/\.ssh\/authorized_keys \]; then/,
    );
  });

  it('refuses input that is not a public key rather than emptying the file', () => {
    // grep -v -F '' matches every line, so a silent pass here would strip every
    // authorized key on the node and lock the owner out of their own cluster.
    expect(() => revokeAuthorizedKeyCommand('')).toThrow(
      /not an ssh public key/i,
    );
    expect(() => revokeAuthorizedKeyCommand('ssh-ed25519')).toThrow();
  });
});
