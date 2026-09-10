import {
  scanArchive,
  DEFAULT_REPO_SNAPSHOT_LIMITS,
} from './repo-archive-scan.util';
import { buildTarGz } from './repo-archive-scan.fixtures';
import type { RepoSnapshotLimits } from '../interfaces/repo-snapshot.interface';

const PREFIX = 'octocat-hello-world-abc1234';

describe('scanArchive', () => {
  it('strips the owner-repo-sha/ prefix and lists the files it finds', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/`, type: 'dir' },
      { path: `${PREFIX}/package.json`, content: '{"name":"hello"}' },
      { path: `${PREFIX}/src/`, type: 'dir' },
      { path: `${PREFIX}/src/index.js`, content: 'console.log("hi")' },
    ]);

    const result = await scanArchive(gz);

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.snapshot.files.sort()).toEqual([
      'package.json',
      'src/index.js',
    ]);
    expect(result.snapshot.truncated).toBe(false);
    expect(result.snapshot.contentComplete).toBe(true);
    expect(result.snapshot.read('package.json')).toBe('{"name":"hello"}');
    expect(result.snapshot.read('src/index.js')).toBe('console.log("hi")');
    expect(result.snapshot.read('does/not/exist')).toBeNull();
    expect(result.snapshot.skipped).toEqual({
      symlinks: 0,
      oversize: 0,
      other: 0,
    });
  });

  it('reports only source-extension files from sources()', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/package.json`, content: '{}' },
      { path: `${PREFIX}/index.js`, content: 'require("x")' },
      { path: `${PREFIX}/README.md`, content: '# hi' },
    ]);

    const result = await scanArchive(gz);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    const paths = result.snapshot
      .sources()
      .map((s) => s.path)
      .sort();
    expect(paths).toContain('index.js');
    expect(paths).not.toContain('README.md');
  });

  it('refuses a symlink entry rather than following it, and counts it', async () => {
    const gz = buildTarGz([
      {
        path: `${PREFIX}/Dockerfile`,
        type: 'symlink',
        linkTarget: '/etc/passwd',
      },
      { path: `${PREFIX}/app.js`, content: 'ok' },
    ]);

    const result = await scanArchive(gz);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.snapshot.files).toEqual(['app.js']);
    expect(result.snapshot.read('Dockerfile')).toBeNull();
    expect(result.snapshot.skipped.symlinks).toBe(1);
  });

  it('refuses a hardlink entry the same way', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/linked`, type: 'hardlink', linkTarget: 'app.js' },
    ]);
    const result = await scanArchive(gz);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.snapshot.files).toEqual([]);
    expect(result.snapshot.skipped.symlinks).toBe(1);
  });

  it('rejects the whole archive when an entry escapes the root via ..', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/../../../etc/passwd`, content: 'root:x:0:0' },
    ]);
    const result = await scanArchive(gz);
    expect(result).toEqual({ ok: false, reason: 'rejected' });
  });

  it('rejects the whole archive on a second top-level component', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/file.txt`, content: 'a' },
      { path: 'something-else/file.txt', content: 'b' },
    ]);
    const result = await scanArchive(gz);
    expect(result).toEqual({ ok: false, reason: 'rejected' });
  });

  it('lists an oversize file without reading it, and clears contentComplete', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/big.bin`, content: 'x'.repeat(200) },
    ]);
    const limits: RepoSnapshotLimits = {
      ...DEFAULT_REPO_SNAPSHOT_LIMITS,
      maxFileBytes: 100,
    };

    const result = await scanArchive(gz, limits);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.snapshot.files).toEqual(['big.bin']);
    expect(result.snapshot.read('big.bin')).toBeNull();
    expect(result.snapshot.skipped.oversize).toBe(1);
    expect(result.snapshot.contentComplete).toBe(false);
  });

  it('truncates the listing once maxEntries is reached', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/a.txt`, content: 'a' },
      { path: `${PREFIX}/b.txt`, content: 'b' },
      { path: `${PREFIX}/c.txt`, content: 'c' },
    ]);
    const limits: RepoSnapshotLimits = {
      ...DEFAULT_REPO_SNAPSHOT_LIMITS,
      maxEntries: 2,
    };

    const result = await scanArchive(gz, limits);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.snapshot.files).toEqual(['a.txt', 'b.txt']);
    expect(result.snapshot.truncated).toBe(true);
    expect(result.snapshot.contentComplete).toBe(false);
  });

  /**
   * The order-independence test below runs under the entry ceiling, where the
   * whole file set survives and only content is chosen. This one runs above
   * it, which is where the ceiling used to decide the set itself in arrival
   * order. `maxEntries` is small on purpose: the boundary is unreachable on
   * any real repository of the corpus (the largest has 15.301 files against a
   * default of 20.000), which is exactly why the defect went unmeasured.
   */
  it('cuts to maxEntries by priority and path, not by the order entries arrive', async () => {
    const entries = [
      { path: `${PREFIX}/src/z.js`, content: 'z' },
      { path: `${PREFIX}/Dockerfile`, content: 'FROM node:20' },
      { path: `${PREFIX}/src/a.js`, content: 'a' },
      { path: `${PREFIX}/package.json`, content: '{"name":"demo"}' },
      { path: `${PREFIX}/src/m.js`, content: 'm' },
    ];
    const limits: RepoSnapshotLimits = {
      ...DEFAULT_REPO_SNAPSHOT_LIMITS,
      maxEntries: 3,
    };

    const forward = await scanArchive(buildTarGz(entries), limits);
    const reversed = await scanArchive(
      buildTarGz([...entries].reverse()),
      limits,
    );
    expect(forward.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (forward.ok === false || reversed.ok === false) return;

    // The two high-density files first, then the alphabetically-first source
    // file — the same (tier, path) order retention already used.
    expect(forward.snapshot.files).toEqual(reversed.snapshot.files);
    expect(forward.snapshot.files).toEqual([
      'Dockerfile',
      'package.json',
      'src/a.js',
    ]);
    expect(forward.snapshot.truncated).toBe(true);
    expect(forward.snapshot.contentComplete).toBe(false);
    expect(reversed.snapshot.truncated).toBe(true);
  });

  it('rejects an archive that decompresses past maxArchiveBytes', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/big.txt`, content: 'y'.repeat(10_000) },
    ]);
    const limits: RepoSnapshotLimits = {
      ...DEFAULT_REPO_SNAPSHOT_LIMITS,
      maxArchiveBytes: 1_000,
    };

    const result = await scanArchive(gz, limits);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reports unreadable for bytes that are not a valid gzip stream', async () => {
    const result = await scanArchive(Buffer.from('not a gzip archive'));
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('retains the same content regardless of the order entries arrive in the archive', async () => {
    const entries = [
      { path: `${PREFIX}/Dockerfile`, content: 'FROM node:20' },
      { path: `${PREFIX}/src/a.js`, content: 'a'.repeat(400) },
      { path: `${PREFIX}/src/b.js`, content: 'b'.repeat(400) },
      { path: `${PREFIX}/package.json`, content: '{"name":"demo"}' },
    ];
    const limits: RepoSnapshotLimits = {
      ...DEFAULT_REPO_SNAPSHOT_LIMITS,
      maxContentBytes: 500,
    };

    const forward = await scanArchive(buildTarGz(entries), limits);
    const reversed = await scanArchive(
      buildTarGz([...entries].reverse()),
      limits,
    );
    expect(forward.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (forward.ok === false || reversed.ok === false) return;

    const retainedIn = (snapshot: typeof forward.snapshot) =>
      snapshot.files.filter((f) => snapshot.read(f) !== null).sort();
    expect(retainedIn(forward.snapshot)).toEqual(retainedIn(reversed.snapshot));
    // The high-density files (Dockerfile, package.json) are retained first,
    // no matter which arrived first in the archive — deterministically ahead
    // of ordinary source even though the fixture leaves enough budget for one
    // of the two same-size source files too.
    expect(retainedIn(forward.snapshot)).toEqual([
      'Dockerfile',
      'package.json',
      'src/a.js',
    ]);
  });

  it('retains a high-density file over an alphabetically earlier source file', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/aaa-earlier-source.js`, content: 'x'.repeat(300) },
      {
        path: `${PREFIX}/Dockerfile`,
        content: 'FROM node:20'.padEnd(300, ' '),
      },
    ]);
    const limits: RepoSnapshotLimits = {
      ...DEFAULT_REPO_SNAPSHOT_LIMITS,
      maxContentBytes: 300,
    };

    const result = await scanArchive(gz, limits);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.snapshot.read('Dockerfile')).not.toBeNull();
    expect(result.snapshot.read('aaa-earlier-source.js')).toBeNull();
  });

  it('never retains a lockfile ahead of ordinary source, and names an unread high-density file in the boundary', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/pnpm-lock.yaml`, content: 'l'.repeat(200) },
      { path: `${PREFIX}/src/app.js`, content: 's'.repeat(200) },
      { path: `${PREFIX}/Dockerfile`, content: 'd'.repeat(200) },
    ]);
    const limits: RepoSnapshotLimits = {
      ...DEFAULT_REPO_SNAPSHOT_LIMITS,
      maxContentBytes: 250,
    };

    const result = await scanArchive(gz, limits);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.snapshot.read('Dockerfile')).not.toBeNull();
    expect(result.snapshot.read('pnpm-lock.yaml')).toBeNull();
    expect(result.snapshot.contentComplete).toBe(false);
    expect(result.snapshot.highDensityUnread).toEqual([]);
  });

  it('declares a high-density file in highDensityUnread when the cap cuts into that tier itself', async () => {
    const gz = buildTarGz([
      { path: `${PREFIX}/Dockerfile`, content: 'd'.repeat(200) },
      { path: `${PREFIX}/package.json`, content: 'p'.repeat(200) },
    ]);
    const limits: RepoSnapshotLimits = {
      ...DEFAULT_REPO_SNAPSHOT_LIMITS,
      maxContentBytes: 250,
    };

    const result = await scanArchive(gz, limits);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    // Alphabetically first among the two high-density candidates wins.
    expect(result.snapshot.read('Dockerfile')).not.toBeNull();
    expect(result.snapshot.read('package.json')).toBeNull();
    expect(result.snapshot.highDensityUnread).toEqual(['package.json']);
  });

  it('resolves a path long enough to need the ustar prefix field', async () => {
    const deepPath = 'nested-directory-segment/'.repeat(6) + 'deep-file.js';
    expect(Buffer.byteLength(`${PREFIX}/${deepPath}`, 'utf8')).toBeGreaterThan(
      100,
    );
    const gz = buildTarGz([
      { path: `${PREFIX}/${deepPath}`, content: 'export {}' },
    ]);
    const result = await scanArchive(gz);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.snapshot.files).toEqual([deepPath]);
    expect(result.snapshot.read(deepPath)).toBe('export {}');
  });
});
