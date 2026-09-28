const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * `--expires` takes a duration from now (`30m`, `8h`, `7d`, `2w`) or a date
 * (`2026-10-01`, `2026-10-01T18:00:00Z`). A bare date means the end of that
 * day in UTC, so "until the 1st" still includes the 1st.
 */
export function parseGrantExpiry(input: string, now = new Date()): Date {
  const value = input.trim();
  const duration = /^(\d+)\s*([mhdw])$/i.exec(value);
  if (duration) {
    const amount = Number(duration[1]);
    if (amount <= 0) throw new Error('--expires must be longer than zero.');
    return new Date(
      now.getTime() + amount * UNIT_MS[duration[2].toLowerCase()],
    );
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T23:59:59Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      `--expires takes a duration (30m, 8h, 7d, 2w) or a date (2026-10-01): got "${input}".`,
    );
  }
  if (date.getTime() <= now.getTime()) {
    throw new Error('--expires must be in the future.');
  }
  return date;
}

export function describeExpiry(
  expiresAt: string | null | undefined,
  now = new Date(),
): { text: string; expired: boolean } {
  if (!expiresAt) return { text: 'standing', expired: false };
  const at = new Date(expiresAt);
  const stamp = at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return at.getTime() > now.getTime()
    ? { text: `until ${stamp}`, expired: false }
    : { text: `expired ${stamp}`, expired: true };
}
