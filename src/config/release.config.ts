/**
 * Release manifest — single source of truth for the versions Flui pins at
 * install time. Shared by the backend (API-driven cluster creation) AND the
 * CLI (which imports it via the `src/*` path alias), so bumping a release means
 * editing this one file. The bootstrap-scripts ref can still be overridden via
 * BOOTSTRAP_SCRIPTS_URL.
 */

export interface ComponentImageTags {
  /** ghcr.io/flui-cloud/core */
  fluiApi: string;
  /** ghcr.io/flui-cloud/dashboard */
  fluiWeb: string;
  /** ghcr.io/flui-cloud/flui-authz */
  fluiAuthz: string;
}

export interface ReleaseManifest {
  /** Platform release version, recorded on the cluster at install. */
  version: string;
  bootstrapRef: string;
  /** Pinned Docker image tags, per Flui component. */
  images: ComponentImageTags;
}

export const RELEASE: ReleaseManifest = {
  version: '0.13.0-rc.4',
  // Commit builds, not release tags. The CI publishes a short-SHA tag for every
  // push to main, so a release can point at exactly what is on the branch
  // without cutting a git tag first — which is what these three refs are: the
  // heads of bootstrap-scripts, flui-core and flui-dashboard.
  bootstrapRef: 'dcefc2b',
  images: {
    fluiApi: '979d7ef',
    fluiWeb: 'de88258',
    // Unchanged: that repository did not move.
    fluiAuthz: '0.6.0',
  },
};

/** GHCR repository → the component slot that pins its tag in this release. */
const COMPONENT_REPOSITORIES: Record<string, keyof ComponentImageTags> = {
  'flui-cloud/core': 'fluiApi',
  'flui-cloud/dashboard': 'fluiWeb',
  'flui-cloud/flui-authz': 'fluiAuthz',
};

/**
 * The tag this release pins for a GHCR repository, or null when the repository
 * is not a Flui component. Lets a version listing keep the pinned build visible
 * even when it is a bare commit SHA that would otherwise age out of the
 * per-commit history window.
 */
export function pinnedTagForRepository(repository: string): string | null {
  const slot = COMPONENT_REPOSITORIES[repository];
  return slot ? RELEASE.images[slot] : null;
}

const LATEST_BOOTSTRAP_REF = 'master';
const LATEST_IMAGE_TAGS: ComponentImageTags = {
  fluiApi: 'latest',
  fluiWeb: 'latest',
  fluiAuthz: 'latest',
};

/** Bootstrap-scripts git ref to install from. `useLatest` → `master`. */
export function resolveBootstrapRef(useLatest: boolean): string {
  return useLatest ? LATEST_BOOTSTRAP_REF : RELEASE.bootstrapRef;
}

/**
 * Knowledge sources the assistant KB is built from — pinned to a ref so the KB tracks the
 * release train (reproducible builds) instead of vendoring committed doc copies. `kb:sync`
 * fetches these public repos at the pinned ref; a local checkout can override via
 * FLUI_DOCS_DIR / FLUI_SPEC_DIR. flui-docs has no tags yet, so docsRef pins a commit.
 */
export interface KnowledgeSources {
  docsRepo: string;
  docsRef: string;
  specRepo: string;
  specRef: string;
}

export const KNOWLEDGE_SOURCES: KnowledgeSources = {
  docsRepo: 'dawit-io/flui-docs',
  docsRef: 'b15332bf2ced531ea0c9252b178334cb0a7930a2',
  specRepo: 'flui-cloud/flui-spec',
  specRef: 'v0.5.0',
};

/** Docker image tags to deploy. `useLatest` → all `latest`. */
export function resolveImageTags(useLatest: boolean): ComponentImageTags {
  return useLatest ? { ...LATEST_IMAGE_TAGS } : { ...RELEASE.images };
}
