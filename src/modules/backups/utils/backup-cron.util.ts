import { CronExpressionParser } from 'cron-parser';

export type Moment = Date | string | null | undefined;

/** A run is due once it has had this long to start and finish being recorded. */
export const MISSED_SLACK_MS = 15 * 60 * 1000;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

export function toDate(value: Moment): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function iso(value: Moment): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "02:00 UTC on 30 Sep", with the year only when it is not the current one. */
export function formatUtcMoment(at: Date, now: Date = new Date()): string {
  const year =
    at.getUTCFullYear() === now.getUTCFullYear()
      ? ''
      : ` ${at.getUTCFullYear()}`;
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC on ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${year}`;
}

function normalizedCron(cron: string): string[] | null {
  try {
    const fields = CronExpressionParser.parse(cron, { tz: 'UTC' })
      .stringify()
      .split(/\s+/);
    return fields.length === 5 ? fields : null;
  } catch {
    return null;
  }
}

const isNumber = (f: string): boolean => /^\d+$/.test(f);

function listOf(field: string): number[] | null {
  const parts = field.split(',');
  if (!parts.every(isNumber)) return null;
  return parts.map(Number);
}

function weekdayList(field: string): number[] | null {
  const out: number[] = [];
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) out.push(d);
    } else if (isNumber(part)) {
      out.push(Number(part));
    } else {
      return null;
    }
  }
  return [...new Set(out.map((d) => d % 7))].sort((a, b) => a - b);
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function describeDays(dow: number[]): string {
  const key = dow.join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  const named = dow.map((d) => WEEKDAYS[d]);
  return joinWords(named);
}

/** Schedules that repeat within a day: every N minutes, every hour, every N hours. */
function describeInterval(min: string, hour: string): string | null {
  if (min === '*' && hour === '*') return 'Every minute';
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === '*') return `Every ${everyMin[1]} minutes`;
  if (!isNumber(min)) return null;
  const atMinute = min === '0' ? '' : ` at minute ${min}`;
  if (hour === '*') return `Every hour${atMinute}`;
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  return everyHour ? `Every ${everyHour[1]} hours${atMinute}` : null;
}

function describeDaily(dom: string, dow: string, times: string): string | null {
  if (dom === '*' && dow === '*') return `Every day at ${times} UTC`;
  if (dom === '*') {
    const days = weekdayList(dow);
    return days ? `${describeDays(days)} at ${times} UTC` : null;
  }
  if (dow === '*' && isNumber(dom)) {
    return `On day ${dom} of every month at ${times} UTC`;
  }
  return null;
}

/** The schedule in words, or `Cron <expr> (UTC)` when it has no plain reading. */
export function describeCron(cron: string | null | undefined): string {
  const expr = cron?.trim();
  if (!expr) return 'On demand only';
  const fallback = `Cron ${expr} (UTC)`;
  const fields = normalizedCron(expr);
  if (!fields) return fallback;
  const [min, hour, dom, month, dow] = fields;
  if (month !== '*') return fallback;
  if (dom === '*' && dow === '*') {
    const interval = describeInterval(min, hour);
    if (interval) return interval;
  }
  const hours = listOf(hour);
  if (!isNumber(min) || !hours) return fallback;
  const times = joinWords(hours.map((h) => `${pad(h)}:${pad(Number(min))}`));
  return describeDaily(dom, dow, times) ?? fallback;
}

/** The last time the schedule asked for a run that should by now have started. */
export function previousDue(
  cron: string | null | undefined,
  now: Date,
): Date | null {
  if (!cron?.trim()) return null;
  try {
    return CronExpressionParser.parse(cron, {
      currentDate: new Date(now.getTime() - MISSED_SLACK_MS),
      tz: 'UTC',
    })
      .prev()
      .toDate();
  } catch {
    return null;
  }
}

export function nextDue(
  cron: string | null | undefined,
  now: Date,
): Date | null {
  if (!cron?.trim()) return null;
  try {
    return CronExpressionParser.parse(cron, { currentDate: now, tz: 'UTC' })
      .next()
      .toDate();
  } catch {
    return null;
  }
}
