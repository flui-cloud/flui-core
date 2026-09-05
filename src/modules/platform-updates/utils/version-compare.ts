/**
 * Semver comparison for release versions, prereleases included.
 *
 * Written here rather than pulled in: the platform ships exactly one kind of
 * version string (`0.13.0-rc.1`, `0.6.0`), and the one rule that matters is the
 * one a naive string compare gets backwards — `0.13.0-rc.1` precedes `0.13.0`,
 * so an installation on a release candidate must be offered the final release.
 */

interface ParsedVersion {
  parts: number[];
  prerelease: string[];
}

function parse(raw: string): ParsedVersion | null {
  const cleaned = raw.trim().replace(/^v/, '');
  const [core, ...rest] = cleaned.split('-');
  const parts = core.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((p) => Number.isNaN(p))) return null;
  while (parts.length < 3) parts.push(0);
  const prerelease = rest.join('-');
  return {
    parts,
    prerelease: prerelease.length > 0 ? prerelease.split('.') : [],
  };
}

function order<T extends string | number>(x: T, y: T): number {
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function compareIdentifier(x: string, y: string): number {
  const nx = Number.parseInt(x, 10);
  const ny = Number.parseInt(y, 10);
  if (!Number.isNaN(nx) && !Number.isNaN(ny)) return order(nx, ny);
  return order(x, y);
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version with no prerelease outranks the same version with one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const verdict = compareIdentifier(x, y);
    if (verdict !== 0) return verdict;
  }
  return 0;
}

/**
 * -1 when `a` is older, 1 when newer, 0 when equal. Returns `null` when either
 * side is not a version at all (a branch tag such as `latest` or `master`),
 * which callers must treat as "cannot be compared" rather than "equal".
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * True when a tag is a release version rather than a commit build or a moving
 * tag. `ec9f4b1` and `latest` are perfectly valid things to be running — they
 * are just not versions, and presenting one as if it were is what makes a
 * dashboard claim an installation is "on its release version" when it is not.
 */
export function isReleaseVersion(raw: string | null | undefined): boolean {
  return !!raw && parse(raw) !== null;
}

/** True when `candidate` is strictly newer than `installed`. */
export function isNewerThan(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) === 1;
}
