/**
 * Bootstrap Scripts Configuration
 *
 * Configuration for downloading initialization scripts from GitHub.
 * Scripts are hosted in the flui-cloud/bootstrap-scripts repository.
 */

import { resolveBootstrapRef } from './release.config';

const BOOTSTRAP_REPO_RAW_BASE =
  'https://raw.githubusercontent.com/flui-cloud/bootstrap-scripts';

/**
 * Base URL for the bootstrap scripts directory.
 *
 * Precedence:
 *  1. `BOOTSTRAP_SCRIPTS_URL` env — full override (dev/CI escape hatch), wins over all.
 *  2. Otherwise derived from the release pin: `<repo>/<ref>/scripts`, where the
 *     ref is the pinned release tag, or `master` when `useLatest`.
 */
export function getScriptsBaseUrl(useLatest = false): string {
  if (process.env.BOOTSTRAP_SCRIPTS_URL) {
    return process.env.BOOTSTRAP_SCRIPTS_URL;
  }
  return `${BOOTSTRAP_REPO_RAW_BASE}/${resolveBootstrapRef(useLatest)}/scripts`;
}

/**
 * The bootstrap-scripts ref a scripts URL installs from, or null when the URL
 * is an override that names no ref in this repository's layout.
 */
export function bootstrapRefOf(scriptsBaseUrl: string): string | null {
  const match = /\/bootstrap-scripts\/([^/]+)\/scripts\/?$/.exec(
    scriptsBaseUrl,
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * What a cluster installed from this URL is built from. The release version is
 * claimed only when the URL installs that release's own ref: an override points
 * somewhere no published release describes.
 */
export function installedReleaseOf(
  scriptsBaseUrl: string,
  release: { version: string | null; bootstrapRef: string },
): { bootstrapRef: string | null; platformRelease: string | null } {
  const bootstrapRef = bootstrapRefOf(scriptsBaseUrl);
  return {
    bootstrapRef,
    platformRelease:
      bootstrapRef !== null && bootstrapRef === release.bootstrapRef
        ? release.version
        : null,
  };
}

export interface BootstrapConfig {
  /**
   * Base URL for downloading scripts
   * Can be overridden via environment variable BOOTSTRAP_SCRIPTS_URL
   */
  scriptsBaseUrl: string;

  /**
   * Available scripts
   */
  scripts: {
    fluiInit: string;
    k3sMaster: string;
    k3sWorker: string;
  };

  /**
   * GitHub repository information
   */
  repository: {
    org: string;
    name: string;
    branch: string;
  };
}

/**
 * Default bootstrap configuration
 */
export const BOOTSTRAP_CONFIG: BootstrapConfig = {
  // Pinned-release default; per-install resolution goes through getScriptsBaseUrl().
  scriptsBaseUrl: getScriptsBaseUrl(false),

  scripts: {
    fluiInit: 'flui-init.sh',
    k3sMaster: 'k3s-master-init.sh',
    k3sWorker: 'k3s-worker-init.sh',
  },

  repository: {
    org: 'flui-cloud',
    name: 'bootstrap-scripts',
    branch: resolveBootstrapRef(false),
  },
};

/**
 * Get the full URL for a script
 */
export function getScriptUrl(
  scriptName: keyof BootstrapConfig['scripts'],
): string {
  return `${BOOTSTRAP_CONFIG.scriptsBaseUrl}/${BOOTSTRAP_CONFIG.scripts[scriptName]}`;
}
