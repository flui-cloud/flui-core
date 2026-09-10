/**
 * How the repository gets read, and the security posture that decides the shape.
 *
 * Today's manifest validation never opens the repository. The one path that
 * does open a repository — public analysis — clones into `os.tmpdir()` with no
 * size ceiling and reads with `fs.readFile`, which follows symlinks: a
 * repository shipping `Dockerfile -> /etc/passwd` gets a host file read back.
 * That path is being replaced, and nothing here may reintroduce its shape.
 *
 * So: **no clone, ever, in the API pod.** One archive, held in memory, with
 * ceilings applied while it is being decoded rather than after, symlink and
 * hardlink entries refused rather than followed, and any entry whose path
 * escapes the archive root refusing the whole archive. Nothing touches the
 * filesystem, so there is no link for anything to follow.
 *
 * Why an archive and not the tree API plus a file at a time: the reader the
 * detectors consume exposes a **synchronous** `read(file)`, and route and env
 * detection greps every source file — which cannot be known in advance. A
 * lazy per-file fetch cannot satisfy a sync read, and fetching every source
 * file individually spends the API budget of a whole corpus on one validation.
 * One archive is one request and one ceiling.
 */

/** Which tree to read. */
export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or SHA. Resolved to a commit SHA, which is what the answers are pinned to. */
  ref: string;
}

/**
 * The ceilings. Two budgets, not one, because they answer different questions:
 * names decide whether absence is provable, bytes decide whether content
 * questions are answerable at all.
 */
export interface RepoSnapshotLimits {
  /** Archive bytes accepted before the read is abandoned as `too-large`. */
  maxArchiveBytes: number;
  /** Paths listed. Passing it clears `listingComplete`, which disables every `fail`. */
  maxEntries: number;
  /** Decompressed content retained across all files. Passing it clears `contentComplete`. */
  maxContentBytes: number;
  /** Per-file ceiling: a file over it is listed and counted as skipped, never read. */
  maxFileBytes: number;
  /** Wall clock for fetch plus decode. A validation runs with a person waiting. */
  timeoutMs: number;
}

/**
 * The bytes of a `.tar.gz` of one commit, and the commit it is.
 *
 * Fetching is flui-core's job because it needs the account's GitHub credential;
 * decoding is the package's job because that is where the ceilings and the
 * symlink refusal are tested offline, in one place, on fixtures. This interface
 * is the seam between the two.
 */
export interface RepoArchive {
  commitSha: string;
  ref: string;
  bytes: Buffer;
}

/**
 * A repository read as the detectors consume it: paths, and a synchronous read
 * of the contents that were retained.
 *
 * Structurally the reader interface the package already defines for the
 * filesystem walk, so the same detectors run over an archive, over a working
 * tree, and over an in-memory fixture with no branch anywhere in between.
 */
export interface RepoSnapshot {
  /** Repository-relative, forward-slashed, shallowest first. */
  files: string[];
  /** True when a ceiling stopped the listing. Absence proves nothing while it is set. */
  truncated: boolean;
  /** Retained content, or null when the file was absent, refused or over its ceiling. */
  read(file: string): string | null;
  /** Source files a route or env search may grep, already read. */
  sources(): Array<{ path: string; content: string }>;
  /** Entries refused, by kind. Carried into the boundary the checks report. */
  skipped: { symlinks: number; oversize: number; other: number };
  contentComplete: boolean;
  /** Decompressed content retained, in bytes. The figure `repo-snapshot` quotes
   * when it has to say that not every listed file was read. */
  bytesRead: number;
  /**
   * High-density paths (a `Dockerfile`, a compose file, a dependency manifest,
   * `schema.prisma`, `settings.py`, `database.yml`, `application.properties`, a
   * `.env*`, …) that were listed but did not make it under `maxContentBytes`
   * even after low-value content (lockfiles, everything else) was retained
   * last. Empty whenever `contentComplete` is true, and also whenever the cap
   * was reached without cutting into this tier — the common case, since this
   * tier is retained first. Named so this specific gap is a stated fact, not
   * folded into `contentComplete` where a reader could not tell "a stylesheet
   * was cut" from "the Dockerfile was cut".
   */
  highDensityUnread: string[];
}

/**
 * What the deploy path calls. One method, and it never throws for a repository
 * it could not read: an unread repository is an answer with a reason, and a
 * thrown error here would turn "we could not look" into a failed validation —
 * the one thing this whole family exists to prevent.
 */
export interface RepoFactsReader {
  factsFor(
    userId: string,
    ref: RepoRef,
    limits?: Partial<RepoSnapshotLimits>,
  ): Promise<import('../manifest-repo-checks.core').RepoFacts>;
}

export const REPO_FACTS_READER = Symbol('REPO_FACTS_READER');
