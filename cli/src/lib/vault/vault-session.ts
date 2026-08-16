/**
 * How long an unlocked vault stays open.
 *
 * Two limits, because one is not enough. The idle window is what makes the
 * vault comfortable: work without interruption, walk away and it closes. The
 * absolute cap is what stops that comfort becoming permanent — a script or a
 * long-running agent that touches the vault every few minutes would otherwise
 * hold the key in memory all day, which is exactly the behaviour the idle
 * window is designed to reward.
 */
export const DEFAULT_IDLE_MS = 30 * 60_000;
export const DEFAULT_MAX_MS = 8 * 60 * 60_000;

export interface SessionLimits {
  idleMs: number;
  maxMs: number;
}

export interface OpenSession {
  open: true;
  idleRemainingMs: number;
  lifeRemainingMs: number;
}
export interface ClosedSession {
  open: false;
  reason: 'idle' | 'expired';
}
export type SessionState = OpenSession | ClosedSession;

/**
 * This project compiles with `strictNullChecks` off, which switches off
 * narrowing on discriminated unions — `if (!state.open)` does not give back the
 * closed variant. An explicit predicate keeps the union honest instead of
 * scattering casts at every call site.
 */
export function isClosed(state: SessionState): state is ClosedSession {
  return state.open === false;
}

export function isOpen(
  state: SessionState | undefined | null,
): state is OpenSession {
  return state?.open === true;
}

/**
 * Reads the limits an operator configured, falling back to the defaults.
 *
 * A value that cannot be read as a positive number falls back rather than
 * failing: a typo in an environment variable must not be able to make the
 * session either permanent or useless.
 */
export function resolveLimits(
  env: NodeJS.ProcessEnv = process.env,
): SessionLimits {
  return {
    idleMs: minutesFrom(env['FLUI_VAULT_IDLE_MINUTES'], DEFAULT_IDLE_MS),
    maxMs: minutesFrom(env['FLUI_VAULT_MAX_MINUTES'], DEFAULT_MAX_MS),
  };
}

function minutesFrom(value: string | undefined, fallback: number): number {
  // `Number`, not `parseInt`: parseInt reads "1.5" as 1 and "30x" as 30, which
  // silently turns a typo into a working-but-wrong session length.
  const minutes = Number(value);
  const usable =
    value !== undefined && value.trim() !== '' && Number.isInteger(minutes);
  return usable && minutes > 0 ? minutes * 60_000 : fallback;
}

/**
 * Decides whether a session is still open, given when it started and when it
 * was last used. Kept as a pure function so the two clocks can be tested
 * without waiting eight hours for one of them.
 */
export function sessionState(
  now: number,
  openedAt: number,
  lastUsedAt: number,
  limits: SessionLimits,
): SessionState {
  if (now - openedAt >= limits.maxMs) return { open: false, reason: 'expired' };
  if (now - lastUsedAt >= limits.idleMs) return { open: false, reason: 'idle' };
  return {
    open: true,
    idleRemainingMs: limits.idleMs - (now - lastUsedAt),
    lifeRemainingMs: limits.maxMs - (now - openedAt),
  };
}

export function describeRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
