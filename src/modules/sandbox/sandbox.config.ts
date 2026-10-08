import {
  SandboxQuota,
  loadSandboxQuota,
} from './constants/sandbox-quota.manifest';

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
  /** After this, a tenancy still "provisioning" is treated as abandoned. */
  provisionStuckMs: number;
  /** Single-node test clusters only. */
  allowMasterPlacement: boolean;
  baseDomain: string;
  /** Pod Security Standard enforced on every guest area. */
  podSecurity: PodSecurityLevel;
  /** What one guest area may consume. */
  quota: SandboxQuota;
  /** Areas the refill builds at most in one pass of the scheduler. */
  maxBuildsPerPass: number;
  /** Seconds one build takes until enough builds have been measured. */
  declaredBuildSeconds: number;
  /**
   * Seconds between a finished build and an application answering on its
   * public address: the wait for a per-app DNS record. Zero on a zone whose
   * wildcard record already covers application hostnames.
   */
  declaredSettleSeconds: number;
  /** What an area holds until a living one can be measured. */
  declaredFootprint: { cpuMillicores: number; memoryMb: number };
  /** Failed teardowns of one area before the operator is asked to help. */
  reapAttemptsBeforeHelp: number;
  /**
   * A guest application held at or above this share of its CPU limit for
   * `cpuAlertMinutes` raises a critical alert: sustained full CPU in a demo
   * area is what mining looks like.
   */
  cpuAlertPercent: number;
  cpuAlertMinutes: number;
  /** Areas that may be held at once: the guests with something deployed. */
  maxSlots: number;
  /**
   * Addresses at these domains, or below them, may look around but never take
   * a space: a throwaway inbox makes a new account per slot free.
   */
  refusedEmailDomains: string[];
  /**
   * How long a handed-out area may stay empty before it is taken back. Long
   * enough that the first deploy, which takes the area before it writes
   * anything, is never caught in between.
   */
  emptyAreaGraceMs: number;
  /**
   * An application lives `workloadTtlHours` from its deploy; while its guest
   * keeps acting it lives until `workloadIdleHours` after their last action,
   * and never beyond `workloadMaxHours` from its deploy.
   */
  workloadIdleMs: number;
  workloadMaxMs: number;
  /** How long before an application goes its guest is told. */
  expiryWarningMs: number;
  /** How long a freed space is held for the first person waiting. */
  waitlistOfferMs: number;
  /** A guest account not seen for this long, and holding no area, is deleted. */
  accountIdleMs: number;
}

export type PodSecurityLevel = 'privileged' | 'baseline' | 'restricted';

const POD_SECURITY_LEVELS: ReadonlySet<PodSecurityLevel> = new Set([
  'privileged',
  'baseline',
  'restricted',
]);

export function podSecurityLabels(
  level: PodSecurityLevel,
): Record<string, string> {
  return {
    'pod-security.kubernetes.io/enforce': level,
    'pod-security.kubernetes.io/warn': level,
  };
}

const hours = (h: number) => h * 60 * 60 * 1000;

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const numOrZero = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
    provisionStuckMs: hours(num(env.SANDBOX_PROVISION_STUCK_HOURS, 1)),
    allowMasterPlacement: env.SANDBOX_ALLOW_MASTER_PLACEMENT === 'true',
    baseDomain: env.SANDBOX_BASE_DOMAIN ?? 'try.flui.cloud',
    podSecurity: POD_SECURITY_LEVELS.has(
      env.SANDBOX_POD_SECURITY as PodSecurityLevel,
    )
      ? (env.SANDBOX_POD_SECURITY as PodSecurityLevel)
      : 'baseline',
    quota: loadSandboxQuota(env),
    maxBuildsPerPass: Math.floor(num(env.SANDBOX_MAX_BUILDS_PER_PASS, 8)),
    declaredBuildSeconds: num(env.SANDBOX_DECLARED_BUILD_SECONDS, 126),
    declaredSettleSeconds: numOrZero(env.SANDBOX_DECLARED_SETTLE_SECONDS, 76),
    declaredFootprint: {
      cpuMillicores: num(env.SANDBOX_DECLARED_FOOTPRINT_CPU_MILLICORES, 500),
      memoryMb: num(env.SANDBOX_DECLARED_FOOTPRINT_MEMORY_MB, 512),
    },
    reapAttemptsBeforeHelp: Math.floor(
      num(env.SANDBOX_REAP_ATTEMPTS_BEFORE_HELP, 3),
    ),
    cpuAlertPercent: num(env.SANDBOX_CPU_ALERT_PERCENT, 90),
    cpuAlertMinutes: Math.floor(num(env.SANDBOX_CPU_ALERT_MINUTES, 15)),
    maxSlots: Math.floor(num(env.SANDBOX_MAX_SLOTS, 20)),
    refusedEmailDomains: refusedEmailDomains(env.SANDBOX_REFUSED_EMAIL_DOMAINS),
    emptyAreaGraceMs: num(env.SANDBOX_EMPTY_AREA_GRACE_MINUTES, 10) * 60 * 1000,
    workloadIdleMs: hours(num(env.SANDBOX_WORKLOAD_IDLE_HOURS, 24)),
    workloadMaxMs: hours(
      Math.max(
        num(env.SANDBOX_WORKLOAD_MAX_HOURS, 72),
        num(env.SANDBOX_WORKLOAD_TTL_HOURS, 24),
      ),
    ),
    expiryWarningMs: hours(num(env.SANDBOX_EXPIRY_WARNING_HOURS, 6)),
    waitlistOfferMs: hours(num(env.SANDBOX_WAITLIST_OFFER_HOURS, 4)),
    accountIdleMs: hours(24 * num(env.SANDBOX_ACCOUNT_IDLE_DAYS, 30)),
  };
}

export const DEFAULT_REFUSED_EMAIL_DOMAINS = [
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'sharklasers.com',
  'grr.la',
  '10minutemail.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmail.net',
  'tmpmail.org',
  'yopmail.com',
  'yopmail.net',
  'trashmail.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'throwawaymail.com',
  'fakeinbox.com',
  'mintemail.com',
  'emailondeck.com',
  'mohmal.com',
  'moakt.com',
  'burnermail.io',
  'tempail.com',
  'mailnesia.com',
  'spamgourmet.com',
  'mytemp.email',
  'tempr.email',
  'discard.email',
  'mail.tm',
];

/** Unset keeps the built-in list; `none` turns it off; anything else replaces it. */
export function refusedEmailDomains(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_REFUSED_EMAIL_DOMAINS;
  }
  if (value.trim().toLowerCase() === 'none') return [];
  return value
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function isRefusedEmail(
  email: string | null | undefined,
  domains: string[],
): boolean {
  const domain = email?.split('@').pop()?.trim().toLowerCase();
  if (!domain || !email?.includes('@')) return false;
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * When a guest's application goes: `workloadTtlHours` after its deploy, pushed
 * to `workloadIdleHours` after the guest's last action while they keep acting,
 * and never later than `workloadMaxHours` after its deploy.
 */
export function workloadDeadline(
  createdAt: Date,
  lastActiveAt: Date | null,
  config: Pick<
    SandboxConfig,
    'workloadTtlMs' | 'workloadIdleMs' | 'workloadMaxMs'
  >,
): Date {
  const born = createdAt.getTime();
  const base = born + config.workloadTtlMs;
  const idle = lastActiveAt
    ? lastActiveAt.getTime() + config.workloadIdleMs
    : 0;
  return new Date(Math.min(born + config.workloadMaxMs, Math.max(base, idle)));
}
