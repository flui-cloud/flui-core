/**
 * Trims the per-commit build history of a GHCR-backed listing.
 *
 * CI tags every push to `main` with a short SHA, so a long-lived image ends up
 * with hundreds of tags (flui-cloud/core: 156 of 173) and the Releases tab
 * becomes unusable. Named tags — semver, `latest`, `main`, branch builds —
 * always survive; so does anything the app ever released, and whatever it is
 * running right now. Only the anonymous SHA-only tail is capped.
 */

// Both CI shapes: the short SHA emitted today and the full 40-char commit SHA
// older workflows pushed. Named tags (semver, `latest`, `main`, branch builds)
// never match — they are not bare hex.
const SHA_ONLY_TAG = /^[0-9a-f]{7,64}$/;

export interface CuratableVersion {
  tag: string;
  allTags?: string[];
  digest?: string;
  createdAt?: string;
  releaseCount?: number;
  isCurrentlyDeployed?: boolean;
}

export interface CurationRefs {
  tags?: (string | null | undefined)[];
  digests?: (string | null | undefined)[];
}

function tagsOf(v: CuratableVersion): string[] {
  const all = [v.tag, ...(v.allTags ?? [])].filter((t): t is string => !!t);
  return all.length > 0 ? all : [];
}

/** A version nobody named: every tag on it is a bare commit SHA. */
function isShaOnly(v: CuratableVersion): boolean {
  const tags = tagsOf(v);
  return tags.length > 0 && tags.every((t) => SHA_ONLY_TAG.test(t));
}

export function curateVersionHistory<T extends CuratableVersion>(
  versions: T[],
  shaHistoryLimit: number,
  refs: CurationRefs = {},
): T[] {
  const keepTags = new Set((refs.tags ?? []).filter((t): t is string => !!t));
  const keepDigests = new Set(
    (refs.digests ?? []).filter((d): d is string => !!d),
  );

  const pinned = (v: T): boolean =>
    !isShaOnly(v) ||
    !!v.isCurrentlyDeployed ||
    (v.releaseCount ?? 0) > 0 ||
    (!!v.digest && keepDigests.has(v.digest)) ||
    tagsOf(v).some((t) => keepTags.has(t));

  const tail = versions
    .filter((v) => !pinned(v))
    .sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0))
    .slice(0, Math.max(0, shaHistoryLimit));
  const kept = new Set<T>(tail);

  return versions.filter((v) => pinned(v) || kept.has(v));
}
