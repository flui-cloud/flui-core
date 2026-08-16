import {
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_MS,
  describeRemaining,
  resolveLimits,
  sessionState,
} from './vault-session';

const LIMITS = { idleMs: 30 * 60_000, maxMs: 8 * 60 * 60_000 };
const T0 = 1_700_000_000_000;

describe('sessionState', () => {
  it('stays open while it is being used', () => {
    // Seven hours in, but used a minute ago: still open. This is the whole
    // point of the idle clock — work is not interrupted.
    const state = sessionState(
      T0 + 7 * 3600_000,
      T0,
      T0 + 7 * 3600_000 - 60_000,
      LIMITS,
    );
    expect(state.open).toBe(true);
  });

  it('closes after the idle window with no use', () => {
    const state = sessionState(T0 + 31 * 60_000, T0, T0, LIMITS);
    expect(state).toEqual({ open: false, reason: 'idle' });
  });

  it('closes at the absolute cap even under continuous use', () => {
    // The case the cap exists for: a loop touching the vault every minute would
    // otherwise hold the key in memory for as long as it runs.
    const now = T0 + 8 * 3600_000;
    const state = sessionState(now, T0, now - 1_000, LIMITS);
    expect(state).toEqual({ open: false, reason: 'expired' });
  });

  it('reports the cap rather than idleness when both have run out', () => {
    const state = sessionState(T0 + 9 * 3600_000, T0, T0, LIMITS);
    expect(state).toEqual({ open: false, reason: 'expired' });
  });

  it('reports how much is left on each clock', () => {
    const state = sessionState(T0 + 10 * 60_000, T0, T0 + 5 * 60_000, LIMITS);
    expect(state).toMatchObject({
      open: true,
      idleRemainingMs: 25 * 60_000,
      lifeRemainingMs: 8 * 3600_000 - 10 * 60_000,
    });
  });

  it('is closed exactly at the boundary, not a moment after', () => {
    expect(sessionState(T0 + LIMITS.idleMs, T0, T0, LIMITS).open).toBe(false);
    expect(sessionState(T0 + LIMITS.idleMs - 1, T0, T0, LIMITS).open).toBe(
      true,
    );
  });
});

describe('resolveLimits', () => {
  it('defaults to thirty minutes idle and eight hours of life', () => {
    expect(resolveLimits({})).toEqual({
      idleMs: DEFAULT_IDLE_MS,
      maxMs: DEFAULT_MAX_MS,
    });
  });

  it('takes configured values in minutes', () => {
    expect(
      resolveLimits({
        FLUI_VAULT_IDLE_MINUTES: '5',
        FLUI_VAULT_MAX_MINUTES: '60',
      }),
    ).toEqual({ idleMs: 5 * 60_000, maxMs: 60 * 60_000 });
  });

  it('falls back rather than letting a typo make the session permanent', () => {
    // "0" or "-1" would otherwise mean an unlimited or already-dead session,
    // neither of which anyone typing it into a shell profile intended.
    for (const bad of ['0', '-1', 'thirty', '', 'NaN', '1.5']) {
      expect(resolveLimits({ FLUI_VAULT_IDLE_MINUTES: bad }).idleMs).toBe(
        DEFAULT_IDLE_MS,
      );
    }
  });
});

describe('describeRemaining', () => {
  it('reads the way a person would say it', () => {
    expect(describeRemaining(30_000)).toBe('less than a minute');
    expect(describeRemaining(25 * 60_000)).toBe('25 min');
    expect(describeRemaining(2 * 3600_000)).toBe('2h');
    expect(describeRemaining(2 * 3600_000 + 15 * 60_000)).toBe('2h 15m');
  });
});
