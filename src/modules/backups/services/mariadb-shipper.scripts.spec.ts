import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.setTimeout(30_000);

const IMAGE = join(__dirname, '../../../../images/mariadb-shipper');
const SHIP = readFileSync(join(IMAGE, 'ship.sh'), 'utf-8');
const RESTORE = join(IMAGE, 'restore.sh');

function fn(name: string): string {
  return new RegExp(String.raw`^${name}\(\) \{\n[\s\S]*?\n\}\n`, 'm').exec(
    SHIP,
  )![0];
}

const FLOOR_FUNCTIONS = [
  'repo_contiguous',
  'repo_plain_size',
  'repo_has_zst',
  'server_size',
  'server_active',
  'complete_in_repo',
  'first_incomplete_log',
  'purge_floor',
  'last_confirmed',
  'drop_plain_duplicates',
];

function ship(
  call: string,
  state: { repo: string[]; server: string[]; oldest?: string; newest?: string },
): string {
  const run = spawnSync(
    'bash',
    [
      '-c',
      [
        'set -uo pipefail',
        `oldest_base_start() { echo ${JSON.stringify(state.oldest ?? '')}; }`,
        `newest_base_start() { echo ${JSON.stringify(state.newest ?? '')}; }`,
        'REMOTE=repo:binlog',
        'exec 3>&1',
        'rc() { echo "$@" >&3; }',
        ...FLOOR_FUNCTIONS.map(fn),
        call,
      ].join('\n'),
    ],
    {
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        REPO_LIST: state.repo.join('\n'),
        SERVER_LOGS: state.server.join('\n'),
      },
    },
  );
  expect(run.stderr).toBe('');
  return run.stdout.trim();
}

describe('shipper: what the server may forget', () => {
  const server = [
    'binlog.000005 640',
    'binlog.000006 700',
    'binlog.000007 379',
  ];

  it('counts a compressed log, or a plain one at the server’s size, as held whole', () => {
    expect(
      ship('first_incomplete_log', {
        server,
        repo: ['300;binlog.000005.zst', '700;binlog.000006'],
      }),
    ).toBe('binlog.000007');
  });

  it('stops at a plain log that is only a prefix of the server’s', () => {
    expect(
      ship('first_incomplete_log', {
        server,
        repo: ['300;binlog.000005.zst', '500;binlog.000006'],
      }),
    ).toBe('binlog.000006');
  });

  it('keeps only what the repository does not hold, however old the newest base is', () => {
    expect(
      ship('purge_floor', {
        server,
        oldest: 'binlog.000002',
        newest: 'binlog.000003',
        repo: [
          '1;binlog.000002',
          '1;binlog.000003.zst',
          '1;binlog.000004.zst',
          '1;binlog.000005.zst',
          '700;binlog.000006',
          '100;binlog.000007',
        ],
      }),
    ).toBe('binlog.000007');
  });

  it('falls back to the base’s own start when the repository has a hole', () => {
    expect(
      ship('purge_floor', {
        server,
        oldest: 'binlog.000002',
        newest: 'binlog.000006',
        repo: [
          '1;binlog.000002',
          '1;binlog.000004.zst',
          '1;binlog.000005.zst',
          '700;binlog.000006',
        ],
      }),
    ).toBe('binlog.000002');
  });

  it('purges nothing before a base exists', () => {
    expect(
      ship('purge_floor', {
        server,
        repo: ['300;binlog.000005.zst', '700;binlog.000006'],
      }),
    ).toBe('');
  });

  it('removes a plain copy only once its compressed one is listed', () => {
    expect(
      ship('drop_plain_duplicates', {
        server,
        repo: ['5;binlog.000003', '3;binlog.000003.zst', '5;binlog.000004'],
      }),
    ).toBe('deletefile repo:binlog/binlog.000003');
  });

  it('names the newest shipped log whatever form it is in', () => {
    expect(
      ship('last_confirmed', {
        server,
        repo: ['1;binlog.000009.zst', '1;binlog.000010', '1;binlog.000008'],
      }),
    ).toBe('binlog.000010');
    expect(
      ship('last_confirmed', {
        server,
        repo: ['1;binlog.000009', '1;binlog.000011.zst'],
      }),
    ).toBe('binlog.000011');
  });
});

/**
 * `restore.sh` end to end against stand-ins: rclone over a directory, and a
 * `zstd` that strips a marker, so a log that was not decompressed shows up in
 * what was replayed.
 */
function restoreFrom(repo: Record<string, string>): {
  status: number | null;
  output: string;
  replayed: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'maria-restore-'));
  const bin = join(root, 'bin');
  const store = join(root, 's3');
  mkdirSync(bin);
  for (const [key, body] of Object.entries(repo)) {
    const path = join(store, 'bkt/app/', key);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    'rclone',
    `
map() { local p="$1"; p="\${p#*:}"; echo "$STORE/$p"; }
case "$1" in
  obscure) cat ;;
  lsf)
    shift; rec=""; while [ "\${1#-}" != "$1" ]; do
      case "$1" in --format) shift ;; -R) rec=1 ;; esac; shift; done
    dir="$(map "$1")"; [ -d "$dir" ] || exit 0
    if [ -n "$rec" ]; then
      (cd "$dir" && find . -type f | sed 's|^\\./||' | sort | sed 's|^|2026-01-01 00:00:00;|')
    else
      (cd "$dir" && for f in *; do [ -d "$f" ] && echo "$f/" || echo "$f"; done)
    fi ;;
  copyto) cp "$(map "$2")" "$3" ;;
  cat) cat "$(map "$2")" ;;
esac`,
  );
  fake('zstd', `sed 's/^ZSTD://'`);
  fake(
    'mbstream',
    'while [ "$1" != "-C" ]; do shift; done; cat > "$2/mariadb_backup_binlog_info"',
  );
  fake('mariadb-backup', 'exit 0');
  fake('mariadbd', 'exit 0');
  fake('chown', 'exit 0');
  fake(
    'mariadb-binlog',
    'for a in "$@"; do case "$a" in --*) ;; *) cat "$a" ;; esac; done',
  );
  fake(
    'mariadb',
    'for a in "$@"; do [ "$a" = "-e" ] && exit 0; done; cat >> "$STORE/replayed"',
  );
  const data = join(root, 'data');
  mkdirSync(data);
  const run = spawnSync('bash', [RESTORE], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      STORE: store,
      FLUI_MARIADB_RESTORE: '1',
      FLUI_MARIADB_S3_BUCKET: 'bkt',
      FLUI_MARIADB_S3_PATH: 'app/',
      FLUI_MARIADB_DATADIR: data,
      FLUI_MARIADB_WORK_DIR: join(root, 'work'),
      FLUI_MARIADB_TARGET_TIME: '2030-01-01 00:00:00',
    },
    encoding: 'utf-8',
  });
  let replayed = '';
  try {
    replayed = readFileSync(join(store, 'replayed'), 'utf-8');
  } catch {
    replayed = '';
  }
  return { status: run.status, output: run.stdout + run.stderr, replayed };
}

const BASE_INFO = 'binlog.000002\t4\t0-1-1\n';

describe('restore: compressed and legacy repositories', () => {
  it('restores a legacy repository with no compression at all', () => {
    const { status, replayed } = restoreFrom({
      'base/base-a/base.mbstream': BASE_INFO,
      'base/base-a/binlog_info': BASE_INFO,
      'binlog/binlog.000002': 'LOG2\n',
      'binlog/binlog.000003': 'LOG3\n',
    });
    expect(status).toBe(0);
    expect(replayed).toMatch(/^LOG2\nLOG3\n/);
  });

  it('decompresses a compressed base and compressed logs', () => {
    const { status, output, replayed } = restoreFrom({
      'base/base-a/base.mbstream.zst': `ZSTD:${BASE_INFO}`,
      'base/base-a/binlog_info': BASE_INFO,
      'binlog/binlog.000002.zst': 'ZSTD:LOG2\n',
      'binlog/binlog.000003.zst': 'ZSTD:LOG3\n',
    });
    expect(status).toBe(0);
    expect(output).toContain('the base backup is compressed');
    expect(replayed).toMatch(/^LOG2\nLOG3\n/);
    expect(replayed).not.toContain('ZSTD:');
  });

  it('reads a repository that changed format midway, preferring the whole compressed copy', () => {
    const { status, replayed } = restoreFrom({
      'base/base-a/base.mbstream': BASE_INFO,
      'base/base-a/binlog_info': BASE_INFO,
      'binlog/binlog.000002': 'LOG2\n',
      'binlog/binlog.000003': 'PREFIX\n',
      'binlog/binlog.000003.zst': 'ZSTD:LOG3\n',
      'binlog/binlog.000004.zst': 'ZSTD:LOG4\n',
    });
    expect(status).toBe(0);
    expect(replayed).toMatch(/^LOG2\nLOG3\nLOG4\n/);
    expect(replayed).not.toContain('PREFIX');
  });

  it('still refuses a hole, whatever form the logs around it are in', () => {
    const { status, output } = restoreFrom({
      'base/base-a/base.mbstream.zst': `ZSTD:${BASE_INFO}`,
      'base/base-a/binlog_info': BASE_INFO,
      'binlog/binlog.000002.zst': 'ZSTD:LOG2\n',
      'binlog/binlog.000004': 'LOG4\n',
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/jump from 2 to 4/);
  });
});
