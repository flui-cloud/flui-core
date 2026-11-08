import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinDetailsScript } from './join-details.util';

describe('joinDetailsScript', () => {
  const details = {
    masterIp: '10.0.1.2',
    k3sToken: "K10ab'cd::server:ef",
    sharedStorageMasterIp: '10.0.1.2',
  };

  it('writes a file the boot script can source back to the same values', () => {
    const root = mkdtempSync(join(tmpdir(), 'join-'));
    const script = joinDetailsScript(details)
      .replaceAll('/var/lib/flui', `${root}/flui`)
      .replace('/etc/systemd/system/k3s.service', `${root}/none`);

    const out = execFileSync('bash', ['-c', script]).toString();
    const read = execFileSync('bash', [
      '-c',
      `. ${root}/flui/k3s-join.env; printf '%s|%s|%s|%s' "$K3S_URL" "$K3S_TOKEN" "$MASTER_IP" "$FLUI_SHARED_STORAGE_MASTER_IP"`,
    ]).toString();

    expect(out.trim()).toBe('join-details-handed-over');
    expect(read).toBe(
      "https://10.0.1.2:6443|K10ab'cd::server:ef|10.0.1.2|10.0.1.2",
    );
    expect(readFileSync(`${root}/flui/k3s-join.env`, 'utf8')).not.toContain(
      'tmp',
    );
  });

  it('hands nothing to a server that already joined', () => {
    const root = mkdtempSync(join(tmpdir(), 'join-'));
    const script = joinDetailsScript(details)
      .replaceAll('/var/lib/flui', `${root}/flui`)
      .replace('/etc/systemd/system/k3s.service', root);

    const out = execFileSync('bash', ['-c', script]).toString();

    expect(out.trim()).toBe('join-details-already-joined');
    expect(() => readFileSync(`${root}/flui/k3s-join.env`)).toThrow();
  });
});
