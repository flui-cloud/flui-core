import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEntry,
  buildIndex,
  changedManifestSets,
  RELEASE_INDEX_SCHEMA_VERSION,
  ReleaseEntry,
} from '../../scripts/release-index';
import { ReleaseManifest } from './release.config';

const release: ReleaseManifest = {
  version: '0.14.0',
  bootstrapRef: 'def5678',
  images: { fluiApi: '0.14.0', fluiWeb: '0.14.0', fluiAuthz: '0.6.0' },
  k3s: { version: 'v1.36.3+k3s1' },
  systemComponents: {
    certManager: 'v1.17.1',
    systemUpgradeController: 'v0.20.2',
  },
};

const schema1Entry: ReleaseEntry = {
  version: '0.13.0',
  publishedAt: '2026-09-01T00:00:00Z',
  bootstrapRef: 'abc1234',
  images: { fluiApi: '0.13.0', fluiWeb: '0.13.0', fluiAuthz: '0.6.0' },
  notes: ['old'],
  migrations: 1,
  requiresBootstrap: false,
};

describe('release-index generator', () => {
  it('writes the K3s version and system components from RELEASE', () => {
    const entry = buildEntry({
      release,
      existing: null,
      previousEntry: schema1Entry,
      publishedAt: '2026-10-01T00:00:00Z',
      migrations: 3,
      notes: ['K3s 1.36'],
    });
    expect(entry).toEqual({
      version: '0.14.0',
      publishedAt: '2026-10-01T00:00:00Z',
      bootstrapRef: 'def5678',
      images: { fluiApi: '0.14.0', fluiWeb: '0.14.0', fluiAuthz: '0.6.0' },
      notes: ['K3s 1.36'],
      migrations: 3,
      requiresBootstrap: true,
      k3s: { version: 'v1.36.3+k3s1' },
      systemComponents: {
        certManager: 'v1.17.1',
        systemUpgradeController: 'v0.20.2',
      },
      manifestSets: ['control', 'workload', 'common'],
    });
  });

  it('names the manifest sets that changed between the two bootstrap refs', () => {
    const entry = buildEntry({
      release,
      existing: null,
      previousEntry: schema1Entry,
      publishedAt: '2026-10-01T00:00:00Z',
      migrations: 0,
      notes: [],
      manifestSets: ['workload'],
    });
    expect(entry.manifestSets).toEqual(['workload']);
  });

  it('names none when the bootstrap did not move', () => {
    const entry = buildEntry({
      release,
      existing: null,
      previousEntry: { ...schema1Entry, bootstrapRef: 'def5678' },
      publishedAt: '2026-10-01T00:00:00Z',
      migrations: 0,
      notes: [],
    });
    expect(entry.manifestSets).toEqual([]);
  });

  it('keeps authored fields of an entry it regenerates', () => {
    const entry = buildEntry({
      release,
      existing: {
        ...schema1Entry,
        version: '0.14.0',
        notes: ['kept'],
        manifestSets: ['workload'],
      },
      previousEntry: { ...schema1Entry, bootstrapRef: 'def5678' },
      publishedAt: '2026-10-01T00:00:00Z',
      migrations: 0,
      notes: [],
      minFrom: '0.12.0',
    });
    expect(entry).toMatchObject({
      notes: ['kept'],
      manifestSets: ['workload'],
      minFrom: '0.12.0',
      requiresBootstrap: false,
    });
  });

  it('publishes schema 2 and leaves older entries as they were', () => {
    const entry = buildEntry({
      release,
      existing: null,
      previousEntry: null,
      publishedAt: '2026-10-01T00:00:00Z',
      migrations: 0,
      notes: [],
    });
    const index = buildIndex(
      { schemaVersion: 1, releases: [schema1Entry] },
      entry,
    );
    expect(RELEASE_INDEX_SCHEMA_VERSION).toBe(2);
    expect(index.schemaVersion).toBe(2);
    expect(index.releases.map((r) => r.version)).toEqual(['0.14.0', '0.13.0']);
    expect(index.releases[1]).toEqual(schema1Entry);
    expect(entry.requiresBootstrap).toBe(true);
  });
});

describe('changedManifestSets', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = (files: Record<string, string>) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    git('add', '-A');
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      'c',
    );
    return git('rev-parse', 'HEAD');
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    git('init', '-q');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('reads which sets moved from the bootstrap repository', () => {
    const a = commit({
      'manifests/control/09-flui-api.yaml': 'a',
      'manifests/workload/vmagent.yaml': 'a',
      'scripts/k3s-master-init.sh': 'a',
    });
    const b = commit({
      'manifests/workload/vmagent.yaml': 'b',
      'scripts/k3s-master-init.sh': 'b',
    });
    const c = commit({ 'manifests/common/02-suc.yaml': 'c' });
    expect(changedManifestSets(repo, a, b)).toEqual(['workload']);
    expect(changedManifestSets(repo, a, c)).toEqual(['workload', 'common']);
    expect(changedManifestSets(repo, a, a)).toEqual([]);
  });

  it('answers null when it cannot tell', () => {
    expect(changedManifestSets(repo, 'nope', 'HEAD')).toBeNull();
    expect(changedManifestSets(join(repo, 'missing'), 'a', 'b')).toBeNull();
  });
});
