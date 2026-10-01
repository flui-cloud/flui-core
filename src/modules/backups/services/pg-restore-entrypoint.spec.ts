import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRYPOINT = join(
  __dirname,
  '../../../../images/postgres/flui-entrypoint.sh',
);

/** The image's `write_restore_conf`, run on its own with `chown` stubbed. */
function writeRestoreConf(env: Record<string, string>): string {
  const source = readFileSync(ENTRYPOINT, 'utf-8');
  const fn = /^write_restore_conf\(\) \{\n[\s\S]*?\n\}\n/m.exec(source)![0];
  const conf = join(mkdtempSync(join(tmpdir(), 'pgconf-')), 'restore.conf');
  const run = spawnSync(
    'bash',
    ['-c', `set -Eeo pipefail\nchown() { :; }\n${fn}\nwrite_restore_conf`],
    {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        RESTORE_CONF: conf,
        PGDATA: '/var/lib/postgresql/data/pgdata',
        FLUI_PG_S3_PATH: '/pfx/pgbackrest/app-1',
        ...env,
      },
      encoding: 'utf-8',
    },
  );
  expect(run.status).toBe(0);
  return readFileSync(conf, 'utf-8');
}

describe('restore-bootstrap pgBackRest configuration', () => {
  it('reads a plaintext repository without a cipher', () => {
    const conf = writeRestoreConf({});
    expect(conf).not.toContain('cipher');
    expect(conf).toContain('repo1-path=/pfx/pgbackrest/app-1\n');
    expect(conf).toMatch(
      /\n\[main\]\npg1-path=\/var\/lib\/postgresql\/data\/pgdata\n$/,
    );
  });

  it('reads an encrypted repository with the passphrase it was given', () => {
    const conf = writeRestoreConf({
      FLUI_PG_S3_PATH: '/pfx/pgbackrest/app-1/encrypted',
      FLUI_PG_CIPHER_PASS: 'p$ss `word` %s',
    });
    const global = conf.split('[main]')[0];
    expect(global).toContain('repo1-cipher-type=aes-256-cbc\n');
    expect(global).toContain('repo1-cipher-pass=p$ss `word` %s\n');
    expect(conf).toMatch(/\n\[main\]\npg1-path=/);
  });
});
