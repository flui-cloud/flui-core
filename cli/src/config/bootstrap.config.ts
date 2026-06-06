/**
 * Bootstrap Scripts Configuration
 *
 * Configuration for downloading initialization scripts from GitHub.
 * Scripts are hosted in the flui-cloud/bootstrap-scripts repository.
 */

import { resolveBootstrapRef } from 'src/config/release.config';
import { resolveEffectiveBootstrapRef } from './release-override';

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
  return `${BOOTSTRAP_REPO_RAW_BASE}/${resolveEffectiveBootstrapRef(useLatest)}/scripts`;
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
  // Static pinned default; per-install (override-aware) resolution goes through
  // getScriptsBaseUrl() at runtime — keep this off the override path so importing
  // the module never reads flui.release.json.
  scriptsBaseUrl: `${BOOTSTRAP_REPO_RAW_BASE}/${resolveBootstrapRef(false)}/scripts`,

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
