import { ValidationOptions, registerDecorator } from 'class-validator';

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MACROS = new Set([
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]);

const FIELDS: { label: string; min: number; max: number; names?: string[] }[] =
  [
    { label: 'minute', min: 0, max: 59 },
    { label: 'hour', min: 0, max: 23 },
    { label: 'day of the month', min: 1, max: 31 },
    { label: 'month', min: 1, max: 12, names: MONTHS },
    { label: 'day of the week', min: 0, max: 7, names: DAYS },
  ];

function valueOf(token: string, field: (typeof FIELDS)[number]): number | null {
  const named = field.names?.indexOf(token.toUpperCase()) ?? -1;
  if (named >= 0) return field.names === MONTHS ? named + 1 : named;
  if (!/^\d+$/.test(token)) return null;
  const n = Number(token);
  return n >= field.min && n <= field.max ? n : null;
}

function fieldProblem(
  part: string,
  field: (typeof FIELDS)[number],
): string | null {
  for (const item of part.split(',')) {
    const [range, step] = item.split('/');
    if (step !== undefined && !/^[1-9]\d*$/.test(step)) {
      return `"${item}" is not a valid ${field.label}`;
    }
    if (range === '*') continue;
    const [from, to] = range.split('-');
    const a = valueOf(from, field);
    const b = to === undefined ? a : valueOf(to, field);
    if (a === null || b === null || (to !== undefined && a > b)) {
      return `"${item}" is not a valid ${field.label} (${field.min}–${field.max})`;
    }
  }
  return null;
}

/** Null when the expression is a valid five-field cron (or a macro); otherwise why not. */
export function cronProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return 'schedule is required, e.g. "0 3 * * *" for every day at 03:00';
  }
  const expr = value.trim();
  if (MACROS.has(expr.toLowerCase())) return null;
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    return `schedule "${expr}" has ${parts.length} field(s); it needs 5 — minute, hour, day of the month, month, day of the week (e.g. "0 3 * * *")`;
  }
  for (let i = 0; i < 5; i++) {
    const problem = fieldProblem(parts[i], FIELDS[i]);
    if (problem) return `schedule: ${problem}`;
  }
  return null;
}

export function isIanaTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || !value.includes('/')) return value === 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function IsCronSchedule(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCronSchedule',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => cronProblem(value) === null,
        defaultMessage: (args) =>
          cronProblem(args?.value) ?? 'invalid schedule',
      },
    });
}

export function IsIanaTimezone(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isIanaTimezone',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isIanaTimezone(value),
        defaultMessage: (args) =>
          `timezone "${String(args?.value)}" is not a known time zone; use a name like Europe/Rome or UTC`,
      },
    });
}
