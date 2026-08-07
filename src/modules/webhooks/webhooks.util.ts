import { ApplicationStatus } from '../applications/enums/application-status.enum';

/**
 * Statuses that mean the app is already live, so a fresh CI build is a
 * redeploy-on-push rather than the app's first deploy. Mirrors the filter used
 * by the build-watcher's findLiveGitBuildApps query.
 */
const LIVE_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  ApplicationStatus.RUNNING,
  ApplicationStatus.DEGRADED,
  ApplicationStatus.UPDATING,
]);

/**
 * Decides whether a successful CI build should roll out automatically.
 *
 * The very first deploy (app not yet live) always proceeds. For an already-live
 * app, auto-deploy on push is opt-in: it proceeds only when deployOnPush is on.
 */
export function shouldAutoDeployOnBuild(
  status: ApplicationStatus,
  deployOnPush: boolean,
): boolean {
  if (!LIVE_STATUSES.has(status)) return true;
  return deployOnPush;
}
