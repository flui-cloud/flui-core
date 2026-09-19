export const SANDBOX_CONFIG = 'SANDBOX_CONFIG';

export interface SandboxConfig {
  /** Master switch. Off means no reserve is built and no claim is accepted. */
  enabled: boolean;
  /** Accepting new visitors. Off closes the door without touching who is inside. */
  acceptingClaims: boolean;
  clusterId: string | null;
  /** How long the guest's account lasts. */
  ttlHours: number;
  ttlMs: number;
  /**
   * How long what the guest deploys lasts, which is the half that costs.
   *
   * Two clocks rather than one because the two things cost differently: an
   * account holds a namespace under a quota and nothing else, so it can be left
   * standing for a week for nothing, while a running workload holds memory and
   * CPU a visitor who left hours ago is not using. Told up front, "what you
   * deploy lives a day" is a rule nobody argues with; discovered afterwards it
   * is a broken promise.
   */
  workloadTtlHours: number;
  workloadTtlMs: number;
  /** Unclaimed tenancies older than this are torn down and rebuilt. */
  recycleUnclaimedMs: number;
  maxClaimsPerIp: number;
  claimWindowMs: number;
  /** After this, a tenancy still "provisioning" is treated as abandoned. */
  provisionStuckMs: number;
  /** Single-node test clusters only. */
  allowMasterPlacement: boolean;
  emailPrefix: string;
  emailDomain: string;
  baseDomain: string;
  ipHashSalt: string;
}

const hours = (h: number) => h * 60 * 60 * 1000;

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): SandboxConfig {
  const ttlHours = num(env.SANDBOX_TTL_HOURS, 24 * 7);
  const workloadTtlHours = num(env.SANDBOX_WORKLOAD_TTL_HOURS, 24);
  return {
    enabled: env.SANDBOX_ENABLED === 'true',
    // Separate from `enabled` on purpose: the switch that stops the bleeding in
    // an incident must not also delete the tenancies of the people already in.
    acceptingClaims: env.SANDBOX_ACCEPTING_CLAIMS !== 'false',
    clusterId: env.SANDBOX_CLUSTER_ID ?? null,
    // How many tenancies to keep warm is deliberately absent from here. A
    // number in the environment cannot know how many visitors are arriving or
    // how much room the cluster has left, and it was wrong in both directions:
    // it paid for idle tenancies at night and ran dry under a rush. See
    // SandboxCapacityService — the answer is arithmetic over two measurements.
    ttlHours,
    ttlMs: hours(ttlHours),
    workloadTtlHours,
    workloadTtlMs: hours(workloadTtlHours),
    recycleUnclaimedMs: hours(num(env.SANDBOX_RECYCLE_UNCLAIMED_HOURS, 48)),
    maxClaimsPerIp: num(env.SANDBOX_MAX_CLAIMS_PER_IP, 3),
    claimWindowMs: hours(num(env.SANDBOX_CLAIM_WINDOW_HOURS, 24)),
    provisionStuckMs: hours(num(env.SANDBOX_PROVISION_STUCK_HOURS, 1)),
    allowMasterPlacement: env.SANDBOX_ALLOW_MASTER_PLACEMENT === 'true',
    emailPrefix: env.SANDBOX_EMAIL_PREFIX ?? 'guest',
    emailDomain: env.SANDBOX_EMAIL_DOMAIN ?? 'try.flui.cloud',
    baseDomain: env.SANDBOX_BASE_DOMAIN ?? 'try.flui.cloud',
    // Only ever used to bucket addresses for the rate limit. A per-instance
    // random salt would reset the counter on every restart, which is exactly
    // what an abuser would wait for.
    ipHashSalt: env.SANDBOX_IP_SALT ?? 'flui-sandbox',
  };
}
