/**
 * Release manifest — single source of truth for the versions Flui pins at
 * install time. Bumped by hand on each CLI release.
 *
 * As long as the installed CLI stays at this version, every component a fresh
 * cluster receives is pinned: the bootstrap scripts/manifests (a git ref on
 * flui-cloud/bootstrap-scripts) and the Docker image tags injected into the
 * cluster. `flui env create --latest` opts back into the mobile dev behaviour
 * (bootstrap ref `master`, `:latest` image tags).
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
  version: '0.5.0',
  bootstrapRef: 'v0.5.0',
  images: {
    fluiApi: '0.5.0',
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

/** Bootstrap-scripts git ref to install from. `--latest` → `master`. */
export function resolveBootstrapRef(useLatest: boolean): string {
  return useLatest ? LATEST_BOOTSTRAP_REF : RELEASE.bootstrapRef;
}

/** Docker image tags to deploy. `--latest` → all `latest`. */
export function resolveImageTags(useLatest: boolean): ComponentImageTags {
  return useLatest ? { ...LATEST_IMAGE_TAGS } : { ...RELEASE.images };
}
