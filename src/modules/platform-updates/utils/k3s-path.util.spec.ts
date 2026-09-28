import { PlatformReleaseEntry } from '../interfaces/release-manifest.interface';
import {
  compareK3sVersions,
  k3sUpgradePath,
  parseK3sVersion,
} from './k3s-path.util';

const release = (version: string, k3s?: string): PlatformReleaseEntry => ({
  version,
  publishedAt: '2026-09-01T00:00:00Z',
  bootstrapRef: 'abc1234',
  images: { fluiApi: version, fluiWeb: version, fluiAuthz: '0.6.0' },
  notes: [],
  migrations: 0,
  requiresBootstrap: false,
  ...(k3s ? { k3s: { version: k3s } } : {}),
});

describe('parseK3sVersion', () => {
  it('reads the K3s release string installs use', () => {
    expect(parseK3sVersion('v1.35.4+k3s1')).toEqual({
      major: 1,
      minor: 35,
      patch: 4,
      prerelease: null,
      revision: 1,
    });
  });

  it('reads a version without the v prefix or the k3s revision', () => {
    expect(parseK3sVersion(' 1.35.4 ')).toMatchObject({
      minor: 35,
      patch: 4,
      revision: 0,
    });
  });

  it('reads a release candidate', () => {
    expect(parseK3sVersion('v1.36.0-rc1+k3s2')).toMatchObject({
      minor: 36,
      prerelease: 'rc1',
      revision: 2,
    });
  });

  it.each(['', 'latest', 'v1.35', '1.35.x+k3s1', 'v1.35.4+k3s', undefined])(
    'rejects %p',
    (raw) => {
      expect(parseK3sVersion(raw)).toBeNull();
    },
  );

  it('orders by revision after the patch, and a final after its candidate', () => {
    const cmp = (a: string, b: string) =>
      compareK3sVersions(parseK3sVersion(a)!, parseK3sVersion(b)!);
    expect(cmp('v1.35.4+k3s2', 'v1.35.4+k3s1')).toBe(1);
    expect(cmp('v1.35.4+k3s1', 'v1.35.10+k3s1')).toBe(-1);
    expect(cmp('v1.36.0+k3s1', 'v1.36.0-rc1+k3s1')).toBe(1);
    expect(cmp('v1.35.4+k3s1', 'v1.35.4+k3s1')).toBe(0);
  });
});

describe('k3sUpgradePath', () => {
  const releases = [
    release('0.13.0', 'v1.35.4+k3s1'),
    release('0.14.0', 'v1.36.1+k3s1'),
    release('0.14.1', 'v1.36.3+k3s1'),
    release('0.15.0', 'v1.37.2+k3s1'),
    release('0.12.0'),
  ];

  it('goes straight to the target across one minor', () => {
    expect(k3sUpgradePath('v1.35.4+k3s1', 'v1.36.3+k3s1', releases)).toEqual({
      steps: ['v1.36.3+k3s1'],
    });
  });

  it('stops on the newest release of each intermediate minor', () => {
    expect(k3sUpgradePath('v1.35.4+k3s1', 'v1.37.2+k3s1', releases)).toEqual({
      steps: ['v1.36.3+k3s1', 'v1.37.2+k3s1'],
    });
  });

  it('picks the newest release by version, not by list order', () => {
    const shuffled = [releases[2], releases[1], releases[0], releases[3]];
    const reversed = [...shuffled].reverse();
    for (const list of [shuffled, reversed]) {
      expect(
        k3sUpgradePath('v1.35.4+k3s1', 'v1.37.2+k3s1', list).steps,
      ).toEqual(['v1.36.3+k3s1', 'v1.37.2+k3s1']);
    }
  });

  it('blocks when no published release ships an intermediate minor', () => {
    const path = k3sUpgradePath('v1.35.4+k3s1', 'v1.39.0+k3s1', releases);
    expect(path.steps).toEqual([]);
    expect(path.blocker).toContain('K3s 1.38');
    const gap = k3sUpgradePath('v1.34.2+k3s1', 'v1.36.1+k3s1', releases);
    expect(gap.blocker).toBeUndefined();
    expect(
      k3sUpgradePath('v1.35.4+k3s1', 'v1.38.0+k3s1', releases).steps,
    ).toEqual(['v1.36.3+k3s1', 'v1.37.2+k3s1', 'v1.38.0+k3s1']);
    const missing = k3sUpgradePath('v1.33.1+k3s1', 'v1.35.4+k3s1', releases);
    expect(missing.steps).toEqual([]);
    expect(missing.blocker).toContain('K3s 1.34');
  });

  it('moves a patch within the same minor in one step', () => {
    expect(k3sUpgradePath('v1.36.1+k3s1', 'v1.36.3+k3s1', releases)).toEqual({
      steps: ['v1.36.3+k3s1'],
    });
    expect(k3sUpgradePath('v1.36.3+k3s1', 'v1.36.3+k3s2', [])).toEqual({
      steps: ['v1.36.3+k3s2'],
    });
  });

  it('never downgrades and does nothing when already there', () => {
    expect(k3sUpgradePath('v1.37.2+k3s1', 'v1.35.4+k3s1', releases)).toEqual({
      steps: [],
    });
    expect(k3sUpgradePath('v1.36.3+k3s1', 'v1.36.1+k3s1', releases)).toEqual({
      steps: [],
    });
    expect(k3sUpgradePath('v1.35.4+k3s1', 'v1.35.4+k3s1', releases)).toEqual({
      steps: [],
    });
  });

  it('blocks on a version it cannot read', () => {
    const observed = k3sUpgradePath('unknown', 'v1.36.3+k3s1', releases);
    expect(observed).toEqual({
      steps: [],
      blocker: expect.stringContaining('"unknown"'),
    });
    const target = k3sUpgradePath('v1.35.4+k3s1', 'v1.36', releases);
    expect(target.blocker).toContain('"v1.36"');
  });

  it('blocks across a major version', () => {
    const path = k3sUpgradePath('v1.35.4+k3s1', 'v2.0.0+k3s1', releases);
    expect(path.steps).toEqual([]);
    expect(path.blocker).toContain('major');
  });
});
