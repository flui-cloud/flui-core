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
  version: '0.12.1',
  bootstrapRef: 'v0.5.4',
  images: {
    fluiApi: '0.12.1',
    fluiWeb: '0.13.0',
    fluiAuthz: '0.6.0',
  },
};

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
