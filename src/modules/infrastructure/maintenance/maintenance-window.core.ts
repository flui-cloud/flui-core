/**
 * When a cluster accepts work that restarts something. A window is a set of
 * weekly slots in one time zone; an application follows its cluster, keeps a
 * slot of its own, or takes such work at any time.
 */

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface MaintenanceSlot {
  days: Weekday[];
  /** Local start time, `HH:MM`. */
  start: string;
  durationMinutes: number;
}

export interface MaintenanceWindow {
  timezone: string;
  slots: MaintenanceSlot[];
}

export const APP_MAINTENANCE_MODES = ['follow', 'own', 'anytime'] as const;
export type AppMaintenanceMode = (typeof APP_MAINTENANCE_MODES)[number];

export interface AppMaintenance {
  mode: AppMaintenanceMode;
  window?: MaintenanceWindow | null;
}

/** What governs an application: its own window, its cluster's, or none at all. */
export type EffectiveWindow =
  | { kind: 'anytime' }
  | { kind: 'window'; window: MaintenanceWindow; source: 'cluster' | 'app' }
  | { kind: 'none'; reason: string };

export function effectiveWindow(
  cluster: MaintenanceWindow | null | undefined,
  app: AppMaintenance | null | undefined,
): EffectiveWindow {
  const mode = app?.mode ?? 'follow';
  if (mode === 'anytime') return { kind: 'anytime' };
  if (mode === 'own') {
    return app?.window?.slots.length
      ? { kind: 'window', window: app.window, source: 'app' }
      : {
          kind: 'none',
          reason:
            'The application is set to its own window, but it names no slot.',
        };
  }
  return cluster?.slots.length
    ? { kind: 'window', window: cluster, source: 'cluster' }
    : {
        kind: 'none',
        reason: 'Set a maintenance window on the cluster first.',
      };
}

/** Problems with a window as written; empty when it can be saved. */
export function windowProblems(window: MaintenanceWindow): string[] {
  const problems: string[] = [];
  if (!isTimeZone(window.timezone))
    problems.push(`"${window.timezone}" is not a time zone.`);
  if (!window.slots.length) problems.push('A window needs at least one slot.');
  window.slots.forEach((slot, i) => {
    const n = i + 1;
    if (!slot.days.length) problems.push(`Slot ${n} names no day.`);
    const bad = slot.days.filter((d) => !WEEKDAYS.includes(d));
    if (bad.length)
      problems.push(`Slot ${n}: ${bad.join(', ')} is not a day (mon…sun).`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.start))
      problems.push(`Slot ${n}: start "${slot.start}" is not HH:MM.`);
    if (!(slot.durationMinutes >= 15 && slot.durationMinutes <= 24 * 60)) {
      problems.push(`Slot ${n}: a slot lasts between 15 minutes and 24 hours.`);
    }
  });
  return problems;
}

/**
 * The next moment the window is open, at or after `now`: `now` itself when a
 * slot is open already. Null for a window with no slot.
 */
export function nextOpening(window: MaintenanceWindow, now: Date): Date | null {
  let best: Date | null = null;
  for (let dayOffset = -1; dayOffset <= 7; dayOffset++) {
    const local = localParts(now, window.timezone);
    const day = new Date(
      Date.UTC(local.year, local.month - 1, local.day + dayOffset),
    );
    const weekday = WEEKDAYS[(day.getUTCDay() + 6) % 7];
    for (const slot of window.slots) {
      if (!slot.days.includes(weekday)) continue;
      const [h, m] = slot.start.split(':').map(Number);
      const start = zonedToUtc(
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        h,
        m,
        window.timezone,
      );
      const end = new Date(start.getTime() + slot.durationMinutes * 60_000);
      if (end <= now) continue;
      const opening = start <= now ? now : start;
      if (!best || opening < best) best = opening;
    }
  }
  return best;
}

/** Whether a slot is open at `now`. */
export function isOpen(window: MaintenanceWindow, now: Date): boolean {
  return nextOpening(window, now)?.getTime() === now.getTime();
}

/** "tue 02:00–04:00 Europe/Rome", one phrase per slot. */
export function describeWindow(window: MaintenanceWindow): string {
  return window.slots
    .map((slot) => {
      const [h, m] = slot.start.split(':').map(Number);
      const endMinutes = (h * 60 + m + slot.durationMinutes) % (24 * 60);
      const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
      return `${slot.days.join(', ')} ${slot.start}–${end}`;
    })
    .join('; ')
    .concat(` ${window.timezone}`);
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function localParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/** A wall-clock time in a zone, as the instant it names. */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const seen = localParts(new Date(guess), timeZone);
  const seenUtc = Date.UTC(
    seen.year,
    seen.month - 1,
    seen.day,
    seen.hour,
    seen.minute,
  );
  return new Date(guess - (seenUtc - guess));
}

export interface DeferredProposalCheck {
  /** Null when nothing asks for a change any more. */
  proposal: {
    problem: string | null;
    verdict: string;
    sentence: string;
  } | null;
}

export type DeferredVerdict =
  | { status: 'apply' }
  | { status: 'discarded' | 'alerted' | 'failed'; outcome: string };

/**
 * What to do with a held resource change once its window opens. The evidence
 * is read again: a reason that went away is not acted on, and a change the
 * cluster has no room for is raised rather than applied into a pod that waits.
 */
export function settleDeferredProposal(
  check: DeferredProposalCheck,
): DeferredVerdict {
  const p = check.proposal;
  if (!p) {
    return {
      status: 'discarded',
      outcome:
        'Nothing asked for the change any more when the window opened; nothing was applied.',
    };
  }
  if (p.problem)
    return { status: 'failed', outcome: `Not applied: ${p.problem}` };
  if (p.verdict === 'fits' || p.verdict === 'buys') return { status: 'apply' };
  return {
    status: 'alerted',
    outcome: `Not applied, because the application would have nowhere to run: ${p.sentence}`,
  };
}
