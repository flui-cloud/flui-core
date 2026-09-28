import { PlatformReleaseEntry } from '../interfaces/release-manifest.interface';
import { compareVersions } from './version-compare';

export interface K3sVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  revision: number;
}

export interface K3sUpgradePath {
  steps: string[];
  blocker?: string;
}

const K3S_VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+?))?(?:\+k3s(\d+))?$/;

/** `v1.35.4+k3s1`, `1.35.4`, `v1.36.0-rc1+k3s2`; anything else is null. */
export function parseK3sVersion(
  raw: string | null | undefined,
): K3sVersion | null {
  if (typeof raw !== 'string') return null;
  const match = K3S_VERSION_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease, revision] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
    revision: revision === undefined ? 0 : Number(revision),
  };
}

export function compareK3sVersions(a: K3sVersion, b: K3sVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease !== b.prerelease) {
    if (a.prerelease === null) return 1;
    if (b.prerelease === null) return -1;
    return (
      compareVersions(`0.0.0-${a.prerelease}`, `0.0.0-${b.prerelease}`) ?? 0
    );
  }
  if (a.revision !== b.revision) return a.revision < b.revision ? -1 : 1;
  return 0;
}

/**
 * The K3s versions to install, in order, to move a cluster from `observed` to
 * `target` one minor at a time. Each intermediate minor takes the K3s version
 * of the newest published release that shipped that minor, so every step is a
 * version some release was tested with. Never downgrades.
 */
export function k3sUpgradePath(
  observed: string,
  target: string,
  releases: PlatformReleaseEntry[],
): K3sUpgradePath {
  const from = parseK3sVersion(observed);
  const to = parseK3sVersion(target);
  if (!from || !to) {
    const unreadable = from ? target : observed;
    return {
      steps: [],
      blocker: `Cannot read K3s version "${unreadable}".`,
    };
  }
  if (compareK3sVersions(from, to) >= 0) return { steps: [] };
  if (from.major !== to.major) {
    return {
      steps: [],
      blocker: `K3s ${observed} → ${target} crosses a major version; no upgrade path is defined.`,
    };
  }

  const newestFirst = [...releases].sort(
    (a, b) => compareVersions(b.version, a.version) ?? 0,
  );
  const steps: string[] = [];
  for (let minor = from.minor + 1; minor < to.minor; minor++) {
    const carrier = newestFirst.find((release) => {
      const shipped = parseK3sVersion(release.k3s?.version);
      return shipped?.major === to.major && shipped.minor === minor;
    });
    if (!carrier?.k3s) {
      return {
        steps: [],
        blocker: `No published Flui release ships K3s ${to.major}.${minor}, so ${observed} cannot reach ${target} one minor version at a time.`,
      };
    }
    steps.push(carrier.k3s.version);
  }
  steps.push(target);
  return { steps };
}
