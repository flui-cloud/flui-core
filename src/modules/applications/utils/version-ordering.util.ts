/**
 * Orders the Releases-tab listing: registry order buries a freshly tagged
 * release (e.g. 0.10.2) among per-commit SHA builds, so float the running
 * version first, then semver newest-first, then the rest by recency.
 */

export interface OrderableVersion {
  tag: string;
  isCurrentlyDeployed: boolean;
  createdAt?: string;
}

export function parseSemverTag(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function sortVersionsForDisplay<T extends OrderableVersion>(
  versions: T[],
): T[] {
  return [...versions].sort((a, b) => {
    if (a.isCurrentlyDeployed !== b.isCurrentlyDeployed) {
      return a.isCurrentlyDeployed ? -1 : 1;
    }
    const av = parseSemverTag(a.tag);
    const bv = parseSemverTag(b.tag);
    if (!!av !== !!bv) return av ? -1 : 1;
    if (av && bv) {
      for (let i = 0; i < 3; i++) {
        if (av[i] !== bv[i]) return bv[i] - av[i];
      }
    }
    return +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0);
  });
}
