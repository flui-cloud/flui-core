/**
 * Whether a version in the list is one this application can actually run.
 *
 * The list used to be "everything the registry holds for this package", which
 * is not the same question. A production application was offered an image built
 * from the `staging` branch of the same repository, and a row called `latest` —
 * a name that points at whatever was built last, so pressing it twice deploys
 * two different things.
 *
 * A row that cannot be pressed teaches people not to trust the rows that can,
 * so the answer carries its reason and the caller keeps them out of the list
 * rather than greying them.
 */
export interface VersionIdentity {
  readonly tag: string;
  readonly allTags?: readonly string[];
  readonly digest?: string | null;
}

/**
 * Tags a registry moves from build to build. They are labels on a version, not
 * versions — the digest underneath changes without the name changing.
 */
export const MOVING_TAGS: readonly string[] = [
  'latest',
  'main',
  'master',
  'edge',
  'stable',
  'nightly',
];

export function isMovingTag(tag: string): boolean {
  return MOVING_TAGS.includes(tag.trim().toLowerCase());
}

export interface ReleasabilityContext {
  /** The branch this application deploys from; null when it has none. */
  readonly branch: string | null;
  /**
   * The branch an image was built from, as the images table recorded it, or
   * null when nothing is on file. Null means unknown, never "another branch":
   * an application whose builds predate the record must keep its whole list.
   */
  readonly recordedBranch: (version: VersionIdentity) => string | null;
}

export interface Releasability {
  readonly releasable: boolean;
  /** Why not, in one sentence, for the row shown behind "show all". */
  readonly reason: string | null;
}

const RELEASABLE: Releasability = { releasable: false, reason: null };

export function judgeReleasable(
  version: VersionIdentity,
  context: ReleasabilityContext,
): Releasability {
  const tags = [version.tag, ...(version.allTags ?? [])].filter(Boolean);
  const hasImmutableName =
    !!version.digest || tags.some((t) => !isMovingTag(t));
  if (!hasImmutableName) {
    const name = tags[0] ?? 'this tag';
    return {
      releasable: false,
      reason: `"${name}" names whatever was built last, not a version.`,
    };
  }

  const built = context.recordedBranch(version);
  if (built && context.branch && built !== context.branch) {
    return {
      releasable: false,
      reason: `Built from "${built}", and this application deploys "${context.branch}".`,
    };
  }

  return { ...RELEASABLE, releasable: true };
}
