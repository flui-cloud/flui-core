import { shouldAutoDeployOnBuild } from './webhooks.util';
import { ApplicationStatus } from '../applications/enums/application-status.enum';

describe('shouldAutoDeployOnBuild', () => {
  it('always deploys the first build (app not yet live), regardless of the flag', () => {
    for (const flag of [true, false]) {
      expect(
        shouldAutoDeployOnBuild(ApplicationStatus.AWAITING_BUILD, flag),
      ).toBe(true);
      expect(
        shouldAutoDeployOnBuild(ApplicationStatus.PROVISIONING, flag),
      ).toBe(true);
    }
  });

  it('gates redeploys of a live app on deployOnPush', () => {
    const live = [
      ApplicationStatus.RUNNING,
      ApplicationStatus.DEGRADED,
      ApplicationStatus.UPDATING,
    ];
    for (const status of live) {
      expect(shouldAutoDeployOnBuild(status, false)).toBe(false);
      expect(shouldAutoDeployOnBuild(status, true)).toBe(true);
    }
  });
});
