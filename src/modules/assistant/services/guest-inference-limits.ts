export const GUEST_INFERENCE_KEYS = [
  'SANDBOX_INFERENCE_ENABLED',
  'SANDBOX_INFERENCE_TOKEN_BUDGET',
  'SANDBOX_VISITOR_INFERENCE_TOKEN_BUDGET',
  'SANDBOX_INFERENCE_DAILY_TOKENS',
  'SANDBOX_INFERENCE_IP_DAILY_TOKENS',
  'SANDBOX_INFERENCE_PER_MINUTE',
  'SANDBOX_INFERENCE_PER_HOUR',
  'SANDBOX_INFERENCE_PER_IP_MINUTE',
  'SANDBOX_INFERENCE_PER_IP_HOUR',
  'SANDBOX_INFERENCE_OFFTOPIC_PER_HOUR',
  'SANDBOX_INFERENCE_OFFTOPIC_COOLDOWN_MINUTES',
  'SANDBOX_INFERENCE_TURN_ALLOWANCE',
] as const;

export type GuestInferenceKey = (typeof GUEST_INFERENCE_KEYS)[number];

export const DEFAULT_GUEST_TOKEN_BUDGET = 200_000;
const DEFAULT_OFFTOPIC_COOLDOWN_MINUTES = 15;
export const DEFAULT_GUEST_TURN_ALLOWANCE = 4_000;

export interface GuestInferenceLimits {
  enabled: boolean;
  areaBudget: number;
  /** Null: a visitor gets the area budget. Zero: the assistant is closed to visitors. */
  visitorBudget: number | null;
  instanceDailyTokens: number | null;
  ipDailyTokens: number | null;
  perMinute: number | null;
  perHour: number | null;
  perIpMinute: number | null;
  perIpHour: number | null;
  offTopicPerHour: number | null;
  offTopicCooldownMs: number;
  /** Tokens a turn needs on top of its first prompt (gate, answer) to be admitted. */
  turnAllowance: number;
}

const limit = (raw: string | undefined): number | null => {
  const parsed = Number(raw);
  return raw?.trim() && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : null;
};

const nonNegative = (raw: string | undefined): number | null => {
  const parsed = Number(raw);
  return raw?.trim() && Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : null;
};

/** With every limit unset, only the area budget applies. */
export function guestInferenceLimits(
  read: (key: GuestInferenceKey) => string | undefined,
): GuestInferenceLimits {
  return {
    enabled:
      read('SANDBOX_INFERENCE_ENABLED')?.trim().toLowerCase() !== 'false',
    areaBudget:
      limit(read('SANDBOX_INFERENCE_TOKEN_BUDGET')) ??
      DEFAULT_GUEST_TOKEN_BUDGET,
    visitorBudget: nonNegative(read('SANDBOX_VISITOR_INFERENCE_TOKEN_BUDGET')),
    instanceDailyTokens: limit(read('SANDBOX_INFERENCE_DAILY_TOKENS')),
    ipDailyTokens: limit(read('SANDBOX_INFERENCE_IP_DAILY_TOKENS')),
    perMinute: limit(read('SANDBOX_INFERENCE_PER_MINUTE')),
    perHour: limit(read('SANDBOX_INFERENCE_PER_HOUR')),
    perIpMinute: limit(read('SANDBOX_INFERENCE_PER_IP_MINUTE')),
    perIpHour: limit(read('SANDBOX_INFERENCE_PER_IP_HOUR')),
    offTopicPerHour: limit(read('SANDBOX_INFERENCE_OFFTOPIC_PER_HOUR')),
    offTopicCooldownMs:
      (limit(read('SANDBOX_INFERENCE_OFFTOPIC_COOLDOWN_MINUTES')) ??
        DEFAULT_OFFTOPIC_COOLDOWN_MINUTES) * 60_000,
    turnAllowance:
      nonNegative(read('SANDBOX_INFERENCE_TURN_ALLOWANCE')) ??
      DEFAULT_GUEST_TURN_ALLOWANCE,
  };
}
