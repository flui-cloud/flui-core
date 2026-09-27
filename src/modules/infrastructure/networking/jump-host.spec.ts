import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JUMP_APPLIED_MARKER,
  JUMP_REFUSED_MARKER,
  JUMP_UNCHANGED_MARKER,
  buildJumpHostScript,
  renderJumpConfig,
} from './jump-host';

/**
 * Runs the script for real against a scratch tree, with an `sshd` whose
 * effective configuration for root changes when `leaks` is true — the case the
 * script exists to refuse.
 */
function run(
  opts: { include?: boolean; leaks?: boolean; valid?: boolean },
  addresses = ['10.250.0.2'],
) {
  const root = mkdtempSync(join(tmpdir(), 'flui-jump-'));
  const bin = join(root, 'bin');
  mkdirSync(join(root, 'etc/ssh/sshd_config.d'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(root, 'etc/ssh/sshd_config'),
    `${opts.include === false ? '' : 'Include /etc/ssh/sshd_config.d/*.conf\n'}PermitRootLogin prohibit-password\n`,
  );
  const dropIn = join(root, 'etc/ssh/sshd_config.d/60-flui-jump.conf');
  const log = join(root, 'calls.log');
  writeFileSync(
    join(bin, 'sshd'),
    `#!/bin/sh
if [ "$1" = "-t" ]; then ${opts.valid === false ? 'exit 1' : 'exit 0'}; fi
echo "permitrootlogin prohibit-password"
if [ -f ${dropIn} ] && [ "${opts.leaks ? '1' : '0'}" = "1" ]; then echo "permitrootlogin no"; fi
`,
    { mode: 0o755 },
  );
  for (const tool of ['id', 'useradd', 'systemctl']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $@" >> ${log}\n`, {
      mode: 0o755,
    });
  }
  const out = execFileSync('sh', ['-c', buildJumpHostScript(addresses, root)], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
  }).toString();
  return {
    out,
    dropIn: existsSync(dropIn) ? readFileSync(dropIn, 'utf-8') : null,
    calls: existsSync(log) ? readFileSync(log, 'utf-8') : '',
    again: () =>
      execFileSync('sh', ['-c', buildJumpHostScript(addresses, root)], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
      }).toString(),
  };
}

describe('the control as the bastion', () => {
  it('lets the jump user forward only to the Flui network addresses, on 22', () => {
    const config = renderJumpConfig(['10.250.0.3', '10.250.0.2', 'not-an-ip']);
    expect(config).toContain('Match User flui-jump');
    expect(config).toContain('PermitOpen 10.250.0.2:22 10.250.0.3:22');
    expect(config).toContain('ForceCommand /usr/sbin/nologin');
    expect(config).toContain('PermitTTY no');
    expect(config).not.toContain('not-an-ip');
  });

  it('opens nothing while there is no member', () => {
    expect(renderJumpConfig([])).toContain('PermitOpen none');
  });

  it('applies the drop-in and reloads sshd when root is untouched', () => {
    const r = run({});
    expect(r.out).toContain(JUMP_APPLIED_MARKER);
    expect(r.dropIn).toContain('PermitOpen 10.250.0.2:22');
    expect(r.calls).toContain('systemctl reload ssh');
    expect(r.again()).toContain(JUMP_UNCHANGED_MARKER);
  });

  it('takes the drop-in back when it would change how root logs in', () => {
    const r = run({ leaks: true });
    expect(r.out).toContain(JUMP_REFUSED_MARKER);
    expect(r.dropIn).toBeNull();
    expect(r.calls).not.toContain('systemctl');
  });

  it('takes it back when sshd rejects it', () => {
    const r = run({ valid: false });
    expect(r.out).toContain(JUMP_REFUSED_MARKER);
    expect(r.dropIn).toBeNull();
  });

  it('touches nothing where sshd_config does not read drop-ins', () => {
    const r = run({ include: false });
    expect(r.out).toContain(JUMP_REFUSED_MARKER);
    expect(r.dropIn).toBeNull();
    expect(r.calls).toBe('');
  });
});
