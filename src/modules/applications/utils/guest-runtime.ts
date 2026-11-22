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

export const EGRESS_BANDWIDTH_ANNOTATION = 'kubernetes.io/egress-bandwidth';
const DEFAULT_GUEST_EGRESS = '20M';
const BANDWIDTH = /^\d+(\.\d+)?[KMG]?$/;

/**
 * How fast a guest's pod may send, enforced by the CNI bandwidth plugin k3s
 * ships. A trial is a look at Flui, not a place to send mail or traffic from;
 * `off` lifts it, and a value that is not a rate keeps the default rather
 * than turning the ceiling into none.
 */
export function guestEgressBandwidth(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.SANDBOX_EGRESS_BANDWIDTH?.trim();
  if (raw === 'off') return null;
  return raw && BANDWIDTH.test(raw) ? raw : DEFAULT_GUEST_EGRESS;
}
