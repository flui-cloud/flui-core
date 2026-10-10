import { loadSandboxConfig } from '../../sandbox/sandbox.config';
import type { ApplicationEntity } from '../entities/application.entity';

/** The application as it is rendered on the guests' cluster: with the guest runtime baseline. */
export function withGuestRuntime<
  T extends Pick<ApplicationEntity, 'clusterId' | 'securityContext'>,
>(app: T, sandboxClusterId: string | null = loadSandboxConfig().clusterId): T {
  if (!sandboxClusterId || app.clusterId !== sandboxClusterId) return app;
  return {
    ...app,
    securityContext: { ...app.securityContext, guestBaseline: true },
  };
}
