jest.mock('@kubernetes/client-node', () => ({}));

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ManifestMasterService,
  restoreScript,
} from './manifest-master.service';

/**
 * Putting a refresh back is what saves an installation whose database did not
 * come back, so the script runs for real against a directory shaped like the
 * master's.
 */
describe('restoring the files a refresh wrote', () => {
  let root: string;
  let dirs: { manifests: string; backups: string; lock: string };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flui-restore-'));
    dirs = {
      manifests: join(root, 'manifests'),
      backups: join(root, 'backups'),
      lock: join(root, 'lock'),
    };
    mkdirSync(dirs.manifests);
    mkdirSync(join(dirs.backups, 'plan1'), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (names: string[]) =>
    spawnSync('sh', ['-c', restoreScript('plan1', names, dirs)], {
      encoding: 'utf8',
    });

  it('brings back a replaced file and removes an added one', () => {
    writeFileSync(join(dirs.manifests, '02-postgres.yaml'), 'new');
    writeFileSync(join(dirs.backups, 'plan1', '02-postgres.yaml'), 'old');
    writeFileSync(join(dirs.manifests, '01b-platform-priority.yaml'), 'added');

    const result = run(['02-postgres.yaml', '01b-platform-priority.yaml']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RESTORED 02-postgres.yaml');
    expect(result.stdout).toContain('REMOVED 01b-platform-priority.yaml');
    expect(readFileSync(join(dirs.manifests, '02-postgres.yaml'), 'utf8')).toBe(
      'old',
    );
    expect(existsSync(join(dirs.manifests, '01b-platform-priority.yaml'))).toBe(
      false,
    );
    expect(existsSync(dirs.lock)).toBe(false);
  });

  it('touches nothing while another refresh holds the lock', () => {
    writeFileSync(join(dirs.manifests, '02-postgres.yaml'), 'new');
    writeFileSync(join(dirs.backups, 'plan1', '02-postgres.yaml'), 'old');
    mkdirSync(dirs.lock);

    const result = run(['02-postgres.yaml']);

    expect(result.stdout).toContain('LOCKED');
    expect(readFileSync(join(dirs.manifests, '02-postgres.yaml'), 'utf8')).toBe(
      'new',
    );
  });
});

describe('ManifestMasterService.restore', () => {
  it('refuses a file name that could escape the manifest directory', async () => {
    const service = new ManifestMasterService({} as never);
    await expect(
      service.restore('kc', 'master-0', 'plan1', ['../etc/passwd']),
    ).rejects.toThrow('Refusing to restore an unexpected name: ../etc/passwd');
    await expect(
      service.restore('kc', 'master-0', 'x;rm', ['02-postgres.yaml']),
    ).rejects.toThrow('Refusing to restore an unexpected name: x;rm');
  });
});
