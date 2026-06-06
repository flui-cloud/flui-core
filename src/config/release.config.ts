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
  /** Git ref (tag) on flui-cloud/bootstrap-scripts holding scripts + manifests. */
  bootstrapRef: string;
  /** Pinned Docker image tags, per Flui component. */
  images: ComponentImageTags;
}

export const RELEASE: ReleaseManifest = {
  version: '0.5.1',
  bootstrapRef: 'v0.5.1',
  images: {
    fluiApi: '0.5.1',
    fluiWeb: '0.5.0',
    fluiAuthz: '0.5.0',
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

/** Docker image tags to deploy. `useLatest` → all `latest`. */
export function resolveImageTags(useLatest: boolean): ComponentImageTags {
  return useLatest ? { ...LATEST_IMAGE_TAGS } : { ...RELEASE.images };
}
